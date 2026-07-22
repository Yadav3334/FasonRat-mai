/**
 * Shared WebRTC session hook for Screen (Remote Desktop) and HVNC pages.
 *
 * Encapsulates: peer connection lifecycle, ICE negotiation, DataChannel binding,
 * connection stats collection, touch/gesture helpers, and session detach/close.
 *
 * Both Screen.tsx and Hvnc.tsx currently inline duplicate WebRTC logic.
 * They should be refactored to call this hook instead.
 */
import { useState, useCallback, useRef } from 'react';
import { clientsApi } from '@/services/api';
import { mapPointerToDevice, type DevicePoint } from '@/lib/remoteDesktop';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
export type GesturePoint = DevicePoint;

export interface WebRtcSessionConfig {
  clientId: string;
  /** Must be stable (use useCallback with minimal deps) */
  sendCommand: (cmd: string, params?: Record<string, unknown>) => Promise<void>;
  /** Start command constant (e.g. CMD.SCREEN or CMD.HVNC) */
  startCmd: string;
  /** Offer command constant */
  offerCmd: string;
  /** Control command constant */
  ctrlCmd: string;
  /** ICE command constant */
  iceCmd: string;
  /** Extra params for start (e.g. HVNC dimensions) */
  startParams?: Record<string, unknown>;
}

function makeSessionId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useWebRtcSession(config: WebRtcSessionConfig) {
  const { clientId, sendCommand, startCmd, offerCmd, ctrlCmd, iceCmd, startParams } = config;

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [fps, setFps] = useState(0);
  const [bitrateKbps, setBitrateKbps] = useState(0);
  const [connectionMode, setConnectionMode] = useState<'P2P' | 'TURN' | null>(null);
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null);
  const [controlReady, setControlReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const sessionRef = useRef('');
  const pendingRemoteIceRef = useRef<RTCIceCandidateInit[]>([]);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStatsRef = useRef<{ bytes: number; time: number } | null>(null);
  const gestureRef = useRef<{ points: GesturePoint[]; startedAt: number; lastAt: number; live: boolean } | null>(null);

  const clearTimers = useCallback(() => {
    if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    connectTimeoutRef.current = null;
    statsTimerRef.current = null;
    lastStatsRef.current = null;
  }, []);

  const detachSession = useCallback((targetSession: string) => {
    if (!targetSession) return;
    void clientsApi.sendCommand(clientId, startCmd, {
      action: 'detach',
      sessionId: targetSession,
    }).catch(() => {});
  }, [clientId, startCmd]);

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

  const bindDataChannel = useCallback((channel: RTCDataChannel, onInfoMessage?: (msg: Record<string, unknown>) => void) => {
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
        const message = JSON.parse(event.data) as Record<string, unknown>;
        onInfoMessage?.(message);
      } catch {
        // Ignore unknown messages.
      }
    };
  }, []);

  const handleConnect = useCallback(async () => {
    detachSession(sessionRef.current);
    closePeer();
    setSessionError(null);
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
        void clientsApi.sendCommand(clientId, iceCmd, {
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
          setSessionError(null);
          if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
          if (!statsTimerRef.current) {
            statsTimerRef.current = setInterval(() => void collectStats(), 1000);
          }
        } else if (pc.connectionState === 'failed') {
          setSessionError('WebRTC connection failed. Check TURN/firewall configuration.');
          detachSession(sessionId);
          closePeer();
        } else if (pc.connectionState === 'disconnected') {
          setConnectionState('connecting');
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await sendCommand(startCmd, { action: 'start', sessionId, ...startParams });
      await sendCommand(offerCmd, {
        sessionId,
        sdp: offer.sdp,
        iceServers,
      });

      connectTimeoutRef.current = setTimeout(() => {
        if (sessionRef.current === sessionId && peerRef.current?.connectionState !== 'connected') {
          setSessionError('Connection timed out. Verify TURN configuration.');
          detachSession(sessionId);
          closePeer();
        }
      }, 60_000);
    } catch {
      setSessionError('Unable to initialize the WebRTC session.');
      detachSession(sessionId);
      closePeer();
    }
  }, [bindDataChannel, clientId, closePeer, collectStats, detachSession, sendCommand, startCmd, offerCmd, iceCmd, startParams]);

  const handleDisconnect = useCallback(() => {
    detachSession(sessionRef.current);
    closePeer();
  }, [closePeer, detachSession]);

  const sendControl = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    const message = JSON.stringify({ action, ...payload });
    const channel = dataChannelRef.current;
    if (channel?.readyState === 'open') {
      try {
        channel.send(message);
        return;
      } catch {
        // Fall through.
      }
    }
    void sendCommand(ctrlCmd, { action, ...payload })
      .catch(() => setSessionError('Unable to send the remote-control action.'));
  }, [sendCommand, ctrlCmd]);

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

  const getPointer = useCallback((
    clientX: number, clientY: number,
    viewportRect: DOMRect,
    screenWidth: number, screenHeight: number,
    videoAspect: number,
  ) => {
    return mapPointerToDevice(clientX, clientY, viewportRect, screenWidth, screenHeight, videoAspect);
  }, []);

  return {
    connectionState, fps, bitrateKbps, connectionMode, relayAvailable, controlReady, sessionError,
    setConnectionState, setFps, setBitrateKbps, setConnectionMode, setRelayAvailable, setControlReady, setSessionError,
    videoRef, peerRef, dataChannelRef, sessionRef, pendingRemoteIceRef,
    connectTimeoutRef, statsTimerRef, lastStatsRef, gestureRef,
    clearTimers, closePeer, collectStats, bindDataChannel, detachSession,
    handleConnect, handleDisconnect, sendControl, sendLiveTouch, getPointer,
  };
}
