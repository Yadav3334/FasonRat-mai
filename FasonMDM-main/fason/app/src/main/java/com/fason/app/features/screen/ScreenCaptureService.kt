package com.fason.app.features.screen

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.fason.app.R
import com.fason.app.core.Protocol
import com.fason.app.core.network.SocketClient
import org.json.JSONObject

/** Foreground-service owner for the user-approved MediaProjection WebRTC session. */
class ScreenCaptureService : Service() {
    private var actionController: RemoteActionController? = null
    private var clearPendingOfferOnDestroy = false

    companion object {
        const val ACTION_START = "START"
        const val ACTION_STOP = "STOP"
        internal const val EXTRA_RESULT_CODE = "RESULT_CODE"
        internal const val EXTRA_DATA = "DATA"
        private const val NOTIFICATION_CHANNEL = "ScreenCaptureChannel"
        private const val NOTIFICATION_ID = 1002

        @Volatile var isStreaming = false
            private set
        @Volatile var screenWidth = 0
            private set
        @Volatile var screenHeight = 0
            private set
        @Volatile var screenDensityDpi = 0
            private set
        @Volatile private var activeService: ScreenCaptureService? = null

        @JvmStatic
        fun handleRemoteAction(message: String): Boolean {
            val controller = activeService?.actionController ?: return false
            controller.handleAction(message)
            return true
        }

        @JvmStatic
        fun isRemoteControlAvailable(): Boolean = RemoteControlService.instance != null

        @JvmStatic
        fun cancelRemoteTouch() {
            RemoteControlService.instance?.cancelContinuousTouch()
        }

        internal fun updateCapturedDimensions(width: Int, height: Int, densityDpi: Int) {
            screenWidth = width.coerceAtLeast(2)
            screenHeight = height.coerceAtLeast(2)
            screenDensityDpi = densityDpi
        }

        @JvmStatic
        fun projectionStopped() {
            isStreaming = false
            activeService?.stopSelf()
        }
    }

    override fun onCreate() {
        super.onCreate()
        activeService = this
        actionController = RemoteActionController()
        createNotificationChannel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                createNotification(),
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, createNotification())
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val data = intent.getParcelableExtra<Intent>(EXTRA_DATA)
                if (resultCode != 0 && data != null) startWebRtc(data) else {
                    WebRtcScreenManager.permissionDenied()
                    stopSelf()
                }
            }
            ACTION_STOP -> {
                clearPendingOfferOnDestroy = true
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startWebRtc(data: Intent) {
        updateDisplayMetrics()
        isStreaming = true
        WebRtcScreenManager.attachProjection(data, screenWidth, screenHeight, screenDensityDpi)
    }

    private fun updateDisplayMetrics() {
        val metrics = readDisplayMetrics()
        updateCapturedDimensions(metrics.width, metrics.height, metrics.densityDpi)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateDisplayMetrics()
        if (isStreaming) {
            WebRtcScreenManager.updateCaptureFormat(screenWidth, screenHeight, screenDensityDpi)
        }
    }

    override fun onDestroy() {
        isStreaming = false
        WebRtcScreenManager.stopSession(clearPendingOffer = clearPendingOfferOnDestroy)
        actionController = null
        if (activeService === this) activeService = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun readDisplayMetrics(): NativeDisplayMetrics {
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds: Rect = windowManager.maximumWindowMetrics.bounds
            NativeDisplayMetrics(bounds.width(), bounds.height(), resources.configuration.densityDpi)
        } else {
            @Suppress("DEPRECATION") val display = windowManager.defaultDisplay
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION") display.getRealMetrics(metrics)
            NativeDisplayMetrics(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL,
                "Remote desktop",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        val stopIntent = Intent(this, ScreenCaptureService::class.java).apply { action = ACTION_STOP }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL)
            .setContentTitle("Remote desktop ready")
            .setContentText("Screen permission stays active for WebRTC reconnects")
            .setSmallIcon(R.mipmap.ic_launcher)
            .addAction(0, "Stop", stopPendingIntent)
            .setOngoing(true)
            .build()
    }

    private data class NativeDisplayMetrics(val width: Int, val height: Int, val densityDpi: Int)
}
