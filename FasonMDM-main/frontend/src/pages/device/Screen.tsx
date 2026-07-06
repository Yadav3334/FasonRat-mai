import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext } from '@/types';
import { CMD } from '@/types';
import { DevicePageHeader, ErrorAlert, StatusBadge } from '@/components/device/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  onScreenStopped,
  onScreenStatus,
  onScreenError,
  onWebRtcAnswer,
  onWebRtcIce,
} from '@/services/socket';
import api from '@/services/api';
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
} from 'lucide-react';

function mapPointerToDevice(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  screenW: number,
  screenH: number,
): { x: number; y: number } | null {
  if (!screenW || !screenH) return null;

  const containerAspect = rect.width / rect.height;
  const screenAspect = screenW / screenH;

  let renderW: number;
  let renderH: number;
  let offsetX: number;
  let offsetY: number;

  if (containerAspect > screenAspect) {
    renderH = rect.height;
    renderW = renderH * screenAspect;
    offsetX = (rect.width - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = rect.width;
    renderH = renderW / screenAspect;
    offsetX = 0;
    offsetY = (rect.height - renderH) / 2;
  }

  const x = clientX - rect.left - offsetX;
  const y = clientY - rect.top - offsetY;

  if (x < 0 || y < 0 || x > renderW || y > renderH) return null;

  return {
    x: Math.round((x / renderW) * screenW),
    y: Math.round((y / renderH) * screenH),
  };
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export default function ScreenPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [streaming, setStreaming] = useState(false);
  const [screenWidth, setScreenWidth] = useState(0);
  const [screenHeight, setScreenHeight] = useState(0);
  const [fps, setFps] = useState(0);
  const [accessible, setAccessible] = useState<boolean | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');

  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const dcReadyRef = useRef(false);
  const pointerStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionNonce = useRef(0);

  const { sendCommand, commandStatus } = useDeviceData<Record<string, never>>({
    clientId,
    page: 'screen',
    extractData: () => ({}),
    dataType: 'screen',
    defaultValue: {},
    socketDebounceMs: 5000,
  });

  const handleCleanup = useCallback(() => {
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    dcReadyRef.current = false;
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    setStreaming(false);
    setConnectionState('disconnected');
    setFps(0);
  }, []);

  const cleanupRef = useRef(handleCleanup);
  cleanupRef.current = handleCleanup;

  const handleDisconnect = useCallback(() => {
    sendCommand(CMD.SCREEN, { action: 'stop' }).catch(() => {});
    handleCleanup();
  }, [sendCommand, handleCleanup]);

  const handleConnect = useCallback(async () => {
    setScreenError(null);
    handleCleanup();
    sessionNonce.current++;
    const myNonce = sessionNonce.current;
    setConnectionState('connecting');
    try {
      await sendCommand(CMD.SCREEN, { action: 'start' });
      await sendCommand(CMD.SCREEN_CTRL, { action: 'status' });
      
      connectTimeoutRef.current = setTimeout(() => {
        if (sessionNonce.current !== myNonce) return;
        setScreenError('Connection timed out. Ensure device is online and permissions are granted.');
        cleanupRef.current();
      }, 15000);
    } catch (err) {
      if (sessionNonce.current !== myNonce) return;
      setScreenError('Failed to send connect command.');
      cleanupRef.current();
    }
  }, [sendCommand, handleCleanup]);

  const initWebRtc = useCallback(async () => {
    const myNonce = sessionNonce.current;
    try {
      const res = await api.get(`/client/${clientId}/webrtc-config`);
      const iceServers = res.data?.data?.iceServers || [];

      const pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      pcRef.current = pc;

      const dc = pc.createDataChannel('control', { ordered: false, maxRetransmits: 0 });
      dcRef.current = dc;

      dc.onopen = () => {
        dcReadyRef.current = true;
      };

      dc.onclose = () => {
        dcReadyRef.current = false;
      };

      dc.onerror = () => {
        dcReadyRef.current = false;
      };

      pc.ontrack = (event) => {
        if (videoRef.current && event.streams && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
          if (sessionNonce.current === myNonce) {
            setStreaming(true);
            setConnectionState('connected');
            if (connectTimeoutRef.current) {
              clearTimeout(connectTimeoutRef.current);
              connectTimeoutRef.current = null;
            }
          }
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendCommand(CMD.WEBRTC_ICE, {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          setScreenError('ICE connection failed. The peer connection was lost.');
          cleanupRef.current();
        } else if (pc.iceConnectionState === 'disconnected') {
          // Try ICE restart before giving up — handles WiFi→4G transitions
          pc.restartIce();
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          cleanupRef.current();
        }
      };

      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);

      await sendCommand(CMD.WEBRTC_OFFER, {
        sdp: pc.localDescription?.sdp,
        iceServers,
      });
    } catch (err) {
      console.error(err);
      if (sessionNonce.current !== myNonce) return;
      setScreenError('Failed to initialize WebRTC connection.');
      cleanupRef.current();
    }
  }, [clientId, sendCommand]);

  useEffect(() => {
    if (connectionState === 'connecting' && !pcRef.current) {
      initWebRtc();
    }
  }, [connectionState, initWebRtc]);

  useEffect(() => {
    const unsubAnswer = onWebRtcAnswer((payload) => {
      if (payload.id !== clientId) return;
      if (pcRef.current && pcRef.current.signalingState !== 'closed') {
        pcRef.current.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }))
          .catch(e => console.error('Failed to set remote answer:', e));
      }
    });

    const unsubIce = onWebRtcIce((payload) => {
      if (payload.id !== clientId) return;
      if (pcRef.current && pcRef.current.signalingState !== 'closed') {
        pcRef.current.addIceCandidate(new RTCIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.sdpMid,
          sdpMLineIndex: payload.sdpMLineIndex
        })).catch(e => console.error('Failed to add ICE candidate:', e));
      }
    });

    const unsubStopped = onScreenStopped((payload) => {
      if (payload.id !== clientId) return;
      cleanupRef.current();
    });

    const unsubStatus = onScreenStatus((payload) => {
      if (payload.id !== clientId) return;
      if (payload.screenWidth) setScreenWidth(payload.screenWidth);
      if (payload.screenHeight) setScreenHeight(payload.screenHeight);
      if (payload.fps !== undefined) setFps(payload.fps);
      if (payload.accessible !== undefined) setAccessible(payload.accessible);
      if (payload.streaming !== undefined) {
        setStreaming(payload.streaming);
      }
    });

    const unsubError = onScreenError((payload) => {
      if (payload.id !== clientId) return;
      setScreenError(payload.error);
      cleanupRef.current();
    });

    return () => {
      unsubAnswer();
      unsubIce();
      unsubStopped();
      unsubStatus();
      unsubError();
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
      }
      cleanupRef.current();
    };
  }, [clientId]);

  const requestStatus = useCallback(async () => {
    try {
      await sendCommand(CMD.SCREEN, { action: 'status' });
      await sendCommand(CMD.SCREEN_CTRL, { action: 'status' });
    } catch {
      // ignore
    }
  }, [sendCommand]);

  useEffect(() => {
    if (online) requestStatus();
  }, [online, requestStatus]);

  const sendCtrlCmd = useCallback((action: string, payload: Record<string, unknown>) => {
    if (dcRef.current && dcReadyRef.current) {
      dcRef.current.send(JSON.stringify({ action, ...payload }));
    } else {
      sendCommand(CMD.SCREEN_CTRL, { action, ...payload }).catch(() => {});
    }
  }, [sendCommand]);

  const sendTap = useCallback((x: number, y: number) => {
    sendCtrlCmd('tap', { x, y });
  }, [sendCtrlCmd]);

  const sendSwipe = useCallback((fromX: number, fromY: number, toX: number, toY: number, dur: number) => {
    sendCtrlCmd('swipe', { fromX, fromY, toX, toY, dur });
  }, [sendCtrlCmd]);

  const sendKey = useCallback((keyCode: string) => {
    sendCtrlCmd('key', { keyCode });
  }, [sendCtrlCmd]);

  const sendText = useCallback(() => {
    if (!textInput.trim()) return;
    sendCtrlCmd('text', { text: textInput });
    setTextInput('');
  }, [sendCtrlCmd, textInput]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!streaming || !viewportRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = viewportRef.current.getBoundingClientRect();
    const coords = mapPointerToDevice(e.clientX, e.clientY, rect, screenWidth, screenHeight);
    if (coords) {
      pointerStart.current = { ...coords, time: Date.now() };
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!streaming || !viewportRef.current || !pointerStart.current) return;

    const rect = viewportRef.current.getBoundingClientRect();
    const end = mapPointerToDevice(e.clientX, e.clientY, rect, screenWidth, screenHeight);
    const start = pointerStart.current;
    pointerStart.current = null;

    if (!end) return;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - start.time;

    if (dist > 20) {
      sendSwipe(start.x, start.y, end.x, end.y, Math.max(150, Math.min(elapsed, 800)));
    } else {
      sendTap(end.x, end.y);
    }
  };

  const resolutionLabel = screenWidth && screenHeight
    ? `${screenWidth}×${screenHeight}`
    : '—';

  const isConnected = connectionState === 'connected';
  const isConnecting = connectionState === 'connecting';

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Live Screen (WebRTC)"
        subtitle={
          isConnected
            ? 'Connected — P2P Video Active'
            : isConnecting
              ? 'Negotiating WebRTC Connection...'
              : 'Remote screen view & control'
        }
        commandStatus={commandStatus}
        badge={
          isConnected
            ? { label: 'LIVE', variant: 'destructive', className: 'animate-pulse' }
            : isConnecting
              ? { label: 'CONNECTING', variant: 'secondary', className: 'animate-pulse' }
              : undefined
        }
        actions={
          isConnected
            ? [
                {
                  label: 'Disconnect',
                  icon: Unplug,
                  onClick: handleDisconnect,
                  disabled: commandStatus === 'sending',
                  variant: 'destructive',
                },
              ]
            : []
        }
      />

      {accessible === false && isConnected && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Accessibility Service required</p>
            <p className="text-xs text-muted-foreground">
              Enable the app&apos;s Accessibility Service on the device (Settings → Accessibility) to use tap, swipe, and text input controls.
            </p>
          </div>
        </div>
      )}

      {screenError && <ErrorAlert message={screenError} onRetry={handleConnect} />}

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          label={isConnected ? 'Connected via WebRTC' : isConnecting ? 'Negotiating...' : 'Disconnected'}
          status={isConnected ? 'success' : isConnecting ? 'warning' : 'neutral'}
        />
        {isConnected && (
          <>
            {fps > 0 && <StatusBadge label={`${fps} FPS`} status="neutral" />}
            <StatusBadge label={resolutionLabel} status="neutral" />
          </>
        )}
        {accessible !== null && isConnected && (
          <StatusBadge
            label={accessible ? 'Remote Control Ready' : 'Remote Control Disabled'}
            status={accessible ? 'success' : 'warning'}
          />
        )}
      </div>

      {/* Screen viewport */}
      <div className="relative rounded-2xl overflow-hidden border border-border/60 bg-black/90 shadow-xl">
        <div
          ref={viewportRef}
          className={`relative aspect-[9/16] max-h-[60vh] mx-auto select-none touch-none ${
            isConnected ? 'cursor-crosshair' : ''
          }`}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            controls={false}
            muted
            className={`absolute inset-0 w-full h-full object-contain pointer-events-none ${!streaming ? 'hidden' : ''}`}
          />
          
          {!streaming && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
              {!online ? (
                <>
                  <div className="rounded-full bg-muted/20 p-6">
                    <Monitor className="h-16 w-16 text-muted-foreground/30" />
                  </div>
                  <div className="text-center space-y-2">
                    <p className="text-sm text-muted-foreground font-medium">Device is offline</p>
                    <p className="text-xs text-muted-foreground/50">
                      The device must be online to connect
                    </p>
                  </div>
                </>
              ) : isConnecting ? (
                <>
                  <div className="relative">
                    <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
                    <div className="relative rounded-full bg-gradient-to-br from-primary/30 to-primary/10 p-8 border border-primary/20">
                      <Loader2 className="h-16 w-16 text-primary animate-spin" />
                    </div>
                  </div>
                  <div className="text-center space-y-2">
                    <p className="text-sm text-primary font-semibold">Establishing WebRTC P2P...</p>
                    <p className="text-xs text-muted-foreground">
                      Negotiating ICE candidates and SDP
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <button
                    onClick={handleConnect}
                    disabled={!online || commandStatus === 'sending'}
                    className="group relative cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none"
                  >
                    <div className="absolute inset-[-16px] rounded-full border-2 border-primary/10 group-hover:border-primary/30 group-hover:scale-110 transition-all duration-500" />
                    <div className="absolute inset-[-8px] rounded-full border border-primary/20 group-hover:border-primary/40 group-hover:scale-105 transition-all duration-300" />
                    <div className="relative rounded-full bg-gradient-to-br from-primary to-primary/80 p-8 shadow-lg shadow-primary/25 group-hover:shadow-xl group-hover:shadow-primary/40 group-hover:scale-105 transition-all duration-300">
                      <Plug className="h-16 w-16 text-primary-foreground drop-shadow-sm" />
                    </div>
                  </button>

                  <div className="text-center space-y-2 mt-2">
                    <p className="text-base text-foreground/90 font-semibold">
                      Click to Connect
                    </p>
                    <p className="text-xs text-muted-foreground max-w-[280px]">
                      Start low-latency WebRTC streaming and remote control
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {streaming && (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-red-500/90 px-2.5 py-1 text-[10px] font-semibold text-white shadow-lg">
              <Radio className="h-3 w-3 animate-pulse" />
              LIVE P2P
            </div>
          )}
        </div>

        {isConnected && (
          <div className="absolute bottom-0 inset-x-0 backdrop-blur-md bg-background/70 border-t border-border/40 p-3">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => sendKey('back')} disabled={!online || !streaming}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => sendKey('home')} disabled={!online || !streaming}>
                <Home className="h-3.5 w-3.5" /> Home
              </Button>
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => sendKey('recents')} disabled={!online || !streaming}>
                <LayoutGrid className="h-3.5 w-3.5" /> Recents
              </Button>
              <div className="w-px h-6 bg-border/40 mx-1 hidden sm:block" />
              <Button size="sm" variant="destructive" className="h-8 gap-1.5" onClick={handleDisconnect} disabled={commandStatus === 'sending'}>
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </Button>
            </div>
          </div>
        )}
      </div>

      {isConnected && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <p className="text-sm font-medium">Text Input</p>
            <div className="flex gap-2">
              <Input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Type text to send..."
                disabled={!online || !streaming}
                onKeyDown={(e) => e.key === 'Enter' && sendText()}
                className="h-9"
              />
              <Button size="sm" onClick={sendText} disabled={!online || !streaming || !textInput.trim()} className="h-9 gap-1.5 shrink-0">
                <Send className="h-3.5 w-3.5" /> Send
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Click on a text field on the device first, then send text. Keystrokes are sent via WebRTC DataChannel for minimal latency.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
