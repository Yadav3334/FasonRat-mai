import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext } from '@/types';
import { CMD } from '@/types';
import { clientsApi } from '@/services/api';
import { DevicePageHeader, ErrorAlert, StatusBadge } from '@/components/device/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { mapPointerToDevice, type DevicePoint } from '@/lib/remoteDesktop';
import {
  onScreenStopped,
  onScreenStatus,
  onScreenError,
  onWebRtcAnswer,
  onWebRtcIce,
  subscribeToScreen,
} from '@/services/socket';
import {
  Monitor,
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
} from 'lucide-react';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';
type GesturePoint = DevicePoint;
type ScreenInfoMessage = {
  type: 'screen-info';
  screenWidth: number;
  screenHeight: number;
  captureWidth?: number;
  captureHeight?: number;
  densityDpi?: number;
  rotation?: number;
};

function makeSessionId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// TODO: Replace inline WebRTC logic below with the shared useWebRtcSession hook
// (see @/hooks/useWebRtcSession). Currently Screen.tsx and Hvnc.tsx duplicate
// the same WebRTC session management, stats collection, and DataChannel handling.

export default function ScreenPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [screenWidth, setScreenWidth] = useState(0);
  const [screenHeight, setScreenHeight] = useState(0);
  const [captureSize, setCaptureSize] = useState({ width: 0, height: 0 });
  const [videoAspect, setVideoAspect] = useState(9 / 16);
  const [fps, setFps] = useState(0);
  const [bitrateKbps, setBitrateKbps] = useState(0);
  const [connectionMode, setConnectionMode] = useState<'P2P' | 'TURN' | null>(null);
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null);
  const [accessible, setAccessible] = useState<boolean | null>(null);
  const [controlReady, setControlReady] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');

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
  const screenSizeRef = useRef({ width: 0, height: 0 });
  const videoAspectRef = useRef(9 / 16);

  const { sendCommand, commandStatus } = useDeviceData<Record<string, never>>({
    clientId,
    page: 'screen',
    extractData: () => ({}),
    dataType: 'screen',
    defaultValue: {},
    socketDebounceMs: 5000,
  });

  const applyScreenSize = useCallback((width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return;
    setScreenWidth(width);
    setScreenHeight(height);
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
    setCaptureSize({ width: 0, height: 0 });
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
        const message = JSON.parse(event.data) as ScreenInfoMessage;
        if (message.type === 'screen-info') applyScreenSize(message.screenWidth, message.screenHeight);
        if (message.type === 'screen-info' && message.captureWidth && message.captureHeight) {
          setCaptureSize({ width: message.captureWidth, height: message.captureHeight });
        }
      } catch {
        // Ignore unknown device-to-panel messages.
      }
    };
  }, [applyScreenSize]);

  const detachSession = useCallback((targetSession: string) => {
    if (!targetSession) return;
    void clientsApi.sendCommand(clientId, CMD.SCREEN, {
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
        void clientsApi.sendCommand(clientId, CMD.WEBRTC_ICE, {
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

      // Ask for user-approved MediaProjection first, then give Android the offer.
      await sendCommand(CMD.SCREEN, { action: 'start', sessionId });
      await sendCommand(CMD.WEBRTC_OFFER, {
        sessionId,
        sdp: offer.sdp,
        iceServers,
      });

      connectTimeoutRef.current = setTimeout(() => {
        if (sessionRef.current === sessionId && peerRef.current?.connectionState !== 'connected') {
          setScreenError('Connection timed out. Accept screen sharing on the device and verify TURN configuration.');
          detachSession(sessionId);
          closePeer();
        }
      }, 60_000);
    } catch {
      setScreenError('Unable to initialize the WebRTC session.');
      detachSession(sessionId);
      closePeer();
    }
  }, [bindDataChannel, clientId, closePeer, collectStats, detachSession, sendCommand]);

  const handleDisconnect = useCallback(() => {
    void sendCommand(CMD.SCREEN, { action: 'stop' });
    detachSession(sessionRef.current);
    closePeer();
  }, [closePeer, detachSession, sendCommand]);

  useEffect(() => {
    const unsub = subscribeToScreen(clientId);
    return () => {
      unsub();
      const sessionId = sessionRef.current;
      void clientsApi.sendCommand(clientId, CMD.SCREEN, { action: 'stop' }).catch(() => {});
      detachSession(sessionId);
      closePeer();
    };
  }, [clientId, closePeer, detachSession]);

  useEffect(() => {
    const unsubAnswer = onWebRtcAnswer(async (payload) => {
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
    const unsubIce = onWebRtcIce(async (payload) => {
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
    const unsubStatus = onScreenStatus((payload) => {
      if (payload.id !== clientId) return;
      if (payload.screenWidth && payload.screenHeight) {
        applyScreenSize(payload.screenWidth, payload.screenHeight);
      }
      if (payload.captureWidth && payload.captureHeight) {
        setCaptureSize({ width: payload.captureWidth, height: payload.captureHeight });
      }
      if (payload.accessible !== undefined) setAccessible(payload.accessible);
      const terminalStates = new Set(['stopped', 'projection-stopped', 'closed']);
      if (
        payload.streaming === false
        && payload.sessionId === sessionRef.current
        && terminalStates.has(payload.connectionState || '')
      ) {
        closePeer();
      }
    });
    const unsubStopped = onScreenStopped((payload) => {
      if (payload.id === clientId) closePeer();
    });
    const unsubError = onScreenError((payload) => {
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
      void sendCommand(CMD.SCREEN, { action: 'status' });
      void sendCommand(CMD.SCREEN_CTRL, { action: 'status' });
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
    void sendCommand(CMD.SCREEN_CTRL, { action, ...payload })
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

  const connected = connectionState === 'connected';
  const connecting = connectionState === 'connecting';
  const resolutionLabel = screenWidth && screenHeight ? `${screenWidth}×${screenHeight}` : '—';
  const viewportStyle = {
    aspectRatio: `${videoAspect}`,
    width: `min(100%, calc(68vh * ${videoAspect}))`,
    maxHeight: '68vh',
  };

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Remote Desktop (WebRTC)"
        subtitle={connected ? `Encrypted ${connectionMode || 'WebRTC'} session` : 'Low-latency remote screen and touch control'}
        commandStatus={commandStatus}
        badge={connected ? { label: 'LIVE', variant: 'destructive', className: 'animate-pulse' } : undefined}
        actions={connected ? [{ label: 'Disconnect', icon: Unplug, onClick: handleDisconnect, variant: 'destructive' }] : []}
      />

      {accessible === false && connected && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <div>
            <p className="text-sm font-medium">Accessibility Service required</p>
            <p className="text-xs text-muted-foreground">Enable Remote Control Service on the device for touch and navigation.</p>
          </div>
        </div>
      )}
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
        <StatusBadge label={connected ? `${connectionMode || 'WebRTC'} connected` : connecting ? 'Connecting WebRTC…' : 'Disconnected'} status={connected ? 'success' : connecting ? 'warning' : 'neutral'} />
        {connected && <StatusBadge label={`${fps} FPS`} status="neutral" />}
        {connected && <StatusBadge label={`${bitrateKbps} kbps`} status="neutral" />}
        {connected && <StatusBadge label={resolutionLabel} status="neutral" />}
        {connected && captureSize.width > 0 && captureSize.height > 0 &&
          (captureSize.width !== screenWidth || captureSize.height !== screenHeight) && (
            <StatusBadge label={`capture ${captureSize.width}×${captureSize.height}`} status="neutral" />
          )}
        {connected && <StatusBadge label={controlReady ? 'DataChannel ready' : 'Control fallback'} status={controlReady ? 'success' : 'warning'} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_5rem]">
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-black/90 shadow-xl">
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
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
                {connecting ? (
                  <>
                    <Loader2 className="h-16 w-16 animate-spin text-primary" />
                    <p className="text-sm font-semibold text-primary">Waiting for device screen permission…</p>
                  </>
                ) : (
                  <>
                    <button onClick={handleConnect} disabled={!online} className="rounded-full bg-primary p-8 shadow-lg disabled:opacity-50">
                      {online ? <Plug className="h-16 w-16 text-primary-foreground" /> : <Monitor className="h-16 w-16 text-muted-foreground" />}
                    </button>
                    <p className="font-semibold">{online ? 'Connect with WebRTC' : 'Device is offline'}</p>
                  </>
                )}
              </div>
            )}
            {connected && (
              <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-red-500/90 px-2.5 py-1 text-[10px] font-semibold text-white">
                <Radio className="h-3 w-3 animate-pulse" /> LIVE
              </div>
            )}
          </div>
        </div>

        <aside className="flex items-center justify-center gap-2 rounded-2xl border bg-card p-2 lg:flex-col">
          <Button size="icon" variant="outline" title="Volume down" aria-label="Volume down" disabled={!connected} onClick={() => sendControl('volume', { direction: 'down' })}>
            <Volume1 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="outline" title="Volume up" aria-label="Volume up" disabled={!connected} onClick={() => sendControl('volume', { direction: 'up' })}>
            <Volume2 className="h-4 w-4" />
          </Button>
          <div className="hidden h-px w-10 bg-border lg:block" />
          <Button size="icon" variant="outline" title="Back" aria-label="Back" disabled={!connected} onClick={() => sendControl('key', { keyCode: 'back' })}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="outline" title="Home" aria-label="Home" disabled={!connected} onClick={() => sendControl('key', { keyCode: 'home' })}>
            <Home className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="outline" title="Recent apps" aria-label="Recent apps" disabled={!connected} onClick={() => sendControl('key', { keyCode: 'recents' })}>
            <LayoutGrid className="h-4 w-4" />
          </Button>
        </aside>
      </div>

      {connected && (
        <div className="flex gap-2">
          <Input
            value={textInput}
            onChange={(event) => setTextInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') sendText(); }}
            placeholder="Type text into the focused field on Android"
          />
          <Button onClick={sendText} disabled={!textInput}><Send className="mr-2 h-4 w-4" />Send</Button>
        </div>
      )}
    </div>
  );
}
