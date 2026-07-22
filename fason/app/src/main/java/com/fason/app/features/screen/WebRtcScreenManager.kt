package com.fason.app.features.screen

import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Build
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
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.ScreenCapturerAndroid
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

/** Keeps one user-approved projection alive while WebRTC viewers attach/detach. */
object WebRtcScreenManager {
    private const val TAG = "WebRtcScreen"
    private const val FPS = 30
    private const val MIN_BITRATE_BPS = 500_000
    private const val START_BITRATE_BPS = 2_000_000
    private const val MAX_BITRATE_BPS = 12_000_000
    private const val MAX_PENDING_ICE_PER_SESSION = 256
    private const val MAX_CONTROL_MESSAGE_BYTES = 64 * 1024

    private val thread = HandlerThread("fason-webrtc").apply { start() }
    private val handler = Handler(thread.looper)
    private val factoryInitialized = AtomicBoolean(false)

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var controlChannel: DataChannel? = null

    private var projectionData: Intent? = null
    private var captureWidth = 0
    private var captureHeight = 0
    private var captureDpi = 0
    private var sessionId = ""
    private var pendingOffer: JSONObject? = null
    private val pendingIce = mutableListOf<Pair<String, IceCandidate>>()
    private val remoteDescriptionSet = AtomicBoolean(false)
    private var projectionGeneration = 0L

    @JvmStatic
    fun handleOffer(data: JSONObject) {
        val copy = JSONObject(data.toString())
        handler.post {
            val incomingSession = copy.optString("sessionId")
            if (incomingSession.isBlank() || copy.optString("sdp").isBlank()) {
                emitError(incomingSession, "Invalid WebRTC offer")
                return@post
            }
            pendingIce.removeAll { it.first != incomingSession }
            pendingOffer = copy
            if (projectionData != null) createPeerFromPendingOffer()
        }
    }

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
            val pc = peerConnection
            if (pc != null && incomingSession == sessionId && remoteDescriptionSet.get()) {
                pc.addIceCandidate(ice)
            } else {
                val sessionCandidateCount = pendingIce.count { it.first == incomingSession }
                if (sessionCandidateCount < MAX_PENDING_ICE_PER_SESSION) {
                    pendingIce.add(incomingSession to ice)
                }
            }
        }
    }

    @JvmStatic
    fun attachProjection(permissionData: Intent, width: Int, height: Int, densityDpi: Int) {
        handler.post {
            projectionData = permissionData
            captureWidth = even(width)
            captureHeight = even(height)
            captureDpi = densityDpi
            createPeerFromPendingOffer()
            if (pendingOffer == null && peerConnection == null) emitStatus(true, "ready")
        }
    }

    @JvmStatic
    fun updateCaptureFormat(width: Int, height: Int, densityDpi: Int) {
        handler.post {
            applyCaptureFormat(width, height, densityDpi)
        }
    }

    @JvmStatic
    fun stopSession(clearPendingOffer: Boolean = true) {
        handler.post { releaseSession(clearPendingOffer) }
    }

    @JvmStatic
    fun detachPeer(targetSession: String = "") {
        handler.post {
            val pendingSession = pendingOffer?.optString("sessionId").orEmpty()
            if (
                targetSession.isNotBlank()
                && targetSession != sessionId
                && targetSession != pendingSession
            ) return@post
            if (targetSession.isBlank() || targetSession == pendingSession) pendingOffer = null
            releasePeerConnectionOnly()
            sessionId = ""
            remoteDescriptionSet.set(false)
            if (targetSession.isBlank()) pendingIce.clear()
            else pendingIce.removeAll { it.first == targetSession }
            videoTrack?.setEnabled(false)
            emitStatus(projectionData != null, if (projectionData != null) "ready" else "stopped")
        }
    }

    @JvmStatic
    fun emitCurrentStatus() {
        handler.post {
            val projectionActive = projectionData != null
            val state = when {
                !projectionActive -> "stopped"
                peerConnection == null -> "ready"
                else -> "connecting"
            }
            emitStatus(projectionActive, state)
        }
    }

    @JvmStatic
    fun permissionDenied() {
        handler.post {
            val pendingSession = pendingOffer?.optString("sessionId").orEmpty()
            emitError(pendingSession, "Screen capture permission was denied on the device")
            pendingOffer = null
            pendingIce.removeAll { it.first == pendingSession }
        }
    }

    private fun createPeerFromPendingOffer() {
        val offer = pendingOffer ?: return
        val permission = projectionData ?: return
        val incomingSession = offer.optString("sessionId")

        releasePeerConnectionOnly()
        sessionId = incomingSession
        remoteDescriptionSet.set(false)
        ensureFactory()

        val rtcConfig = PeerConnection.RTCConfiguration(parseIceServers(offer.optJSONArray("iceServers"))).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            enableCpuOveruseDetection = true
            // RTCConfiguration keeps this legacy field in kbps. Sender and
            // PeerConnection#setBitrate use bps.
            screencastMinBitrate = MIN_BITRATE_BPS / 1_000
        }
        val pc = factory?.createPeerConnection(rtcConfig, createPeerObserver(incomingSession))
        if (pc == null) {
            failPeerConnection(incomingSession, "Unable to create WebRTC peer connection")
            return
        }
        peerConnection = pc

        try {
            ensureCaptureStarted(permission)
            val track = videoTrack ?: error("Screen capture track is unavailable")
            track.setEnabled(true)
        } catch (error: Exception) {
            Log.e(TAG, "Unable to start WebRTC screen capture", error)
            emitError(sessionId, error.message ?: "Unable to start screen capture")
            releaseSession(clearPendingOffer = false)
            ScreenCaptureService.projectionStopped()
            return
        }

        val remoteOffer = SessionDescription(SessionDescription.Type.OFFER, offer.optString("sdp"))
        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                if (sessionId != incomingSession) return
                val track = videoTrack
                if (track == null) {
                    failPeerConnection(incomingSession, "Screen capture track is unavailable")
                    return
                }
                // Let the remote offer create/associate the recv-only video
                // transceiver first, then attach our track to that m-line.
                try {
                    pc.addTrack(track, listOf("fason-screen"))
                    configureSender()
                } catch (error: Exception) {
                    failPeerConnection(incomingSession, error.message ?: "Unable to attach the screen track")
                    return
                }
                remoteDescriptionSet.set(true)
                flushPendingIce()
                createAnswer(pc, incomingSession)
            }

            override fun onSetFailure(error: String) {
                if (sessionId == incomingSession) {
                    failPeerConnection(incomingSession, "Unable to apply WebRTC offer: $error")
                }
            }
        }, remoteOffer)
        pendingOffer = null
        emitStatus(true, "connecting")
    }

    private fun ensureCaptureStarted(permission: Intent) {
        if (capturer != null && videoSource != null && videoTrack != null) return

        val source = factory!!.createVideoSource(true)
        source.setIsScreencast(true)
        source.adaptOutputFormat(captureWidth, captureHeight, FPS)
        videoSource = source

        val helper = SurfaceTextureHelper.create("fason-screen-capture", eglBase!!.eglBaseContext)
        surfaceHelper = helper
        val generation = ++projectionGeneration
        val screenCapturer = ScreenCapturerAndroid(permission, object : MediaProjection.Callback() {
            override fun onCapturedContentResize(width: Int, height: Int) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
                handler.post {
                    if (generation != projectionGeneration) return@post
                    val density = FasonApp.getContext().resources.configuration.densityDpi
                    ScreenCaptureService.updateCapturedDimensions(
                        width,
                        height,
                        density,
                        ScreenCaptureService.screenRotation,
                    )
                    applyCaptureFormat(width, height, density)
                }
            }

            override fun onStop() {
                handler.post {
                    if (generation != projectionGeneration) return@post
                    emitStatus(false, "projection-stopped")
                    releaseSession(clearPendingOffer = true)
                    ScreenCaptureService.projectionStopped()
                }
            }
        })
        capturer = screenCapturer
        screenCapturer.initialize(helper, FasonApp.getContext(), source.capturerObserver)
        screenCapturer.startCapture(captureWidth, captureHeight, FPS)

        videoTrack = factory!!.createVideoTrack("fason-screen-video", source).apply {
            setEnabled(true)
        }
    }

    private fun createAnswer(pc: PeerConnection, peerSession: String) {
        pc.createAnswer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(answer: SessionDescription) {
                if (sessionId != peerSession) return
                pc.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        if (sessionId != peerSession) return
                        val payload = JSONObject().apply {
                            put("sessionId", peerSession)
                            put("sdp", answer.description)
                        }
                        SocketClient.getInstance().socket?.emit(Protocol.WEBRTC_ANSWER, payload)
                    }

                    override fun onSetFailure(error: String) {
                        if (sessionId == peerSession) {
                            failPeerConnection(peerSession, "Unable to apply WebRTC answer: $error")
                        }
                    }
                }, answer)
            }

            override fun onCreateFailure(error: String) {
                if (sessionId == peerSession) {
                    failPeerConnection(peerSession, "Unable to create WebRTC answer: $error")
                }
            }
        }, MediaConstraints())
    }

    private fun createPeerObserver(peerSession: String) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit

        override fun onIceCandidate(candidate: IceCandidate) {
            if (sessionId != peerSession) return
            val payload = JSONObject().apply {
                put("sessionId", peerSession)
                put("candidate", candidate.sdp)
                put("sdpMid", candidate.sdpMid)
                put("sdpMLineIndex", candidate.sdpMLineIndex)
            }
            SocketClient.getInstance().socket?.emit(Protocol.WEBRTC_ICE, payload)
        }

        override fun onDataChannel(channel: DataChannel) {
            handler.post {
                if (sessionId == peerSession) bindControlChannel(channel) else channel.dispose()
            }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (sessionId != peerSession) return
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED -> emitStatus(true, "connected")
                PeerConnection.IceConnectionState.DISCONNECTED -> emitStatus(true, "disconnected")
                PeerConnection.IceConnectionState.FAILED -> {
                    emitError(peerSession, "WebRTC ICE connection failed")
                    handler.post {
                        if (sessionId != peerSession) return@post
                        releasePeerConnectionOnly()
                        sessionId = ""
                        videoTrack?.setEnabled(false)
                        emitStatus(true, "ready")
                    }
                }
                PeerConnection.IceConnectionState.CLOSED -> Unit
                else -> Unit
            }
        }
    }

    private fun bindControlChannel(channel: DataChannel) {
        ScreenCaptureService.cancelRemoteTouch()
        try { controlChannel?.unregisterObserver() } catch (_: Exception) {}
        try { controlChannel?.close() } catch (_: Exception) {}
        try { controlChannel?.dispose() } catch (_: Exception) {}
        controlChannel = channel
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit
            override fun onStateChange() {
                handler.post {
                    if (controlChannel !== channel) return@post
                    when (channel.state()) {
                        DataChannel.State.OPEN -> sendScreenInfo()
                        DataChannel.State.CLOSING,
                        DataChannel.State.CLOSED -> ScreenCaptureService.cancelRemoteTouch()
                        else -> Unit
                    }
                }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                if (buffer.data.remaining() > MAX_CONTROL_MESSAGE_BYTES) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                ScreenCaptureService.handleRemoteAction(String(bytes, StandardCharsets.UTF_8))
            }
        })
        if (channel.state() == DataChannel.State.OPEN) sendScreenInfo()
    }

    private fun failPeerConnection(targetSession: String, message: String) {
        emitError(targetSession, message)
        handler.post {
            if (sessionId != targetSession) return@post
            releasePeerConnectionOnly()
            remoteDescriptionSet.set(false)
            sessionId = ""
            videoTrack?.setEnabled(false)
            emitStatus(projectionData != null, if (projectionData != null) "ready" else "stopped")
        }
    }

    private fun configureSender() {
        val sender = peerConnection?.senders?.firstOrNull { it.track()?.kind() == "video" } ?: return
        val parameters = sender.parameters
        parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        val target = min(MAX_BITRATE_BPS, max(MIN_BITRATE_BPS, captureWidth * captureHeight * 3))
        parameters.encodings.forEach {
            it.minBitrateBps = MIN_BITRATE_BPS
            it.maxBitrateBps = target
            it.maxFramerate = FPS
            it.scaleResolutionDownBy = 1.0
        }
        if (!sender.setParameters(parameters)) {
            Log.w(TAG, "WebRTC sender rejected native-resolution parameters")
        }
        peerConnection?.setBitrate(MIN_BITRATE_BPS, min(START_BITRATE_BPS, target), target)
    }

    private fun applyCaptureFormat(width: Int, height: Int, densityDpi: Int) {
        val nextWidth = even(width)
        val nextHeight = even(height)
        val changed = nextWidth != captureWidth || nextHeight != captureHeight
        captureWidth = nextWidth
        captureHeight = nextHeight
        captureDpi = densityDpi
        try {
            if (changed) {
                capturer?.changeCaptureFormat(captureWidth, captureHeight, FPS)
                videoSource?.adaptOutputFormat(captureWidth, captureHeight, FPS)
            }
            configureSender()
            sendScreenInfo()
            emitStatus(true, if (peerConnection == null) "ready" else "connected")
        } catch (error: Exception) {
            Log.w(TAG, "Unable to update capture format", error)
        }
    }

    private fun sendScreenInfo() {
        val channel = controlChannel ?: return
        if (channel.state() != DataChannel.State.OPEN) return
        val payload = JSONObject().apply {
            put("type", "screen-info")
            put(Protocol.KEY_SCREEN_W, ScreenCaptureService.screenWidth.takeIf { it > 0 } ?: captureWidth)
            put(Protocol.KEY_SCREEN_H, ScreenCaptureService.screenHeight.takeIf { it > 0 } ?: captureHeight)
            put(Protocol.KEY_CAPTURE_W, captureWidth)
            put(Protocol.KEY_CAPTURE_H, captureHeight)
            put(Protocol.KEY_DENSITY_DPI, captureDpi)
            put(Protocol.KEY_ROTATION, ScreenCaptureService.screenRotation)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        channel.send(DataChannel.Buffer(ByteBuffer.wrap(payload), false))
    }

    private fun flushPendingIce() {
        val pc = peerConnection ?: return
        val iterator = pendingIce.iterator()
        while (iterator.hasNext()) {
            val (candidateSession, candidate) = iterator.next()
            if (candidateSession == sessionId) {
                pc.addIceCandidate(candidate)
                iterator.remove()
            }
        }
    }

    private fun parseIceServers(array: JSONArray?): List<PeerConnection.IceServer> {
        val result = mutableListOf<PeerConnection.IceServer>()
        if (array == null) return result
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
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

    private fun ensureFactory() {
        if (factoryInitialized.compareAndSet(false, true)) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(FasonApp.getContext())
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
        }
        if (eglBase == null) eglBase = EglBase.create()
        if (factory == null) {
            val eglContext = eglBase!!.eglBaseContext
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglContext))
                .createPeerConnectionFactory()
        }
    }

    private fun releaseSession(clearPendingOffer: Boolean) {
        emitStatus(false, "stopped")
        releasePeerConnectionOnly()
        releaseCapture()
        projectionData = null
        remoteDescriptionSet.set(false)
        val preservedSession = if (clearPendingOffer) "" else pendingOffer?.optString("sessionId").orEmpty()
        if (preservedSession.isBlank()) pendingIce.clear()
        else pendingIce.removeAll { it.first != preservedSession }
        if (clearPendingOffer) pendingOffer = null
        sessionId = ""
    }

    private fun releasePeerConnectionOnly() {
        ScreenCaptureService.cancelRemoteTouch()
        try { controlChannel?.unregisterObserver() } catch (_: Exception) {}
        try { controlChannel?.close() } catch (_: Exception) {}
        try { controlChannel?.dispose() } catch (_: Exception) {}
        controlChannel = null
        try { peerConnection?.close() } catch (_: Exception) {}
        try { peerConnection?.dispose() } catch (_: Exception) {}
        peerConnection = null
    }

    private fun releaseCapture() {
        projectionGeneration++
        try { capturer?.stopCapture() } catch (_: Exception) {}
        try { capturer?.dispose() } catch (_: Exception) {}
        capturer = null
        try { surfaceHelper?.dispose() } catch (_: Exception) {}
        surfaceHelper = null
        try { videoTrack?.dispose() } catch (_: Exception) {}
        videoTrack = null
        try { videoSource?.dispose() } catch (_: Exception) {}
        videoSource = null
    }

    private fun emitStatus(streaming: Boolean, connectionState: String) {
        val deviceWidth = ScreenCaptureService.screenWidth.takeIf { it > 0 } ?: captureWidth
        val deviceHeight = ScreenCaptureService.screenHeight.takeIf { it > 0 } ?: captureHeight
        val status = JSONObject().apply {
            put(Protocol.KEY_TYPE, Protocol.KEY_STATUS)
            put(Protocol.KEY_STREAMING, streaming)
            put(Protocol.KEY_SCREEN_W, deviceWidth)
            put(Protocol.KEY_SCREEN_H, deviceHeight)
            put(Protocol.KEY_CAPTURE_W, captureWidth)
            put(Protocol.KEY_CAPTURE_H, captureHeight)
            put(Protocol.KEY_DENSITY_DPI, captureDpi)
            put(Protocol.KEY_ROTATION, ScreenCaptureService.screenRotation)
            put("fps", FPS)
            put("transport", "webrtc")
            put("connectionState", connectionState)
            put("sessionId", sessionId)
            put(Protocol.KEY_ACCESSIBLE, ScreenCaptureService.isRemoteControlAvailable())
        }
        SocketClient.getInstance().socket?.emit(Protocol.SCREEN, status)
    }

    private fun emitError(targetSession: String, message: String) {
        val error = JSONObject().apply {
            put(Protocol.KEY_TYPE, Protocol.KEY_ERROR)
            put(Protocol.KEY_ERROR, message)
            put("sessionId", targetSession)
        }
        SocketClient.getInstance().socket?.emit(Protocol.SCREEN, error)
    }

    private fun even(value: Int): Int = max(2, value - value % 2)

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }
}
