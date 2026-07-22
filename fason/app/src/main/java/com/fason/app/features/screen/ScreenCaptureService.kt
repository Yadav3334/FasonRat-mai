package com.fason.app.features.screen

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.fason.app.R

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
        /** Current display rotation, in Surface.ROTATION_* values. */
        @Volatile var screenRotation = 0
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

        internal fun updateCapturedDimensions(
            width: Int,
            height: Int,
            densityDpi: Int,
            rotation: Int = screenRotation,
        ) {
            screenWidth = width.coerceAtLeast(2)
            screenHeight = height.coerceAtLeast(2)
            screenDensityDpi = densityDpi
            screenRotation = rotation
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
            try {
                startForeground(
                    NOTIFICATION_ID,
                    createNotification(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                )
            } catch (e: SecurityException) {
                Log.w("ScreenCapture", "FGS type fallback", e)
                startForeground(NOTIFICATION_ID, createNotification())
            } catch (e: RuntimeException) {
                // Android 14+ may throw if foregroundServiceType doesn't match manifest
                Log.w("ScreenCapture", "FGS runtime fallback", e)
                startForeground(NOTIFICATION_ID, createNotification())
            }
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
        updateCapturedDimensions(metrics.width, metrics.height, metrics.densityDpi, metrics.rotation)
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
        // MediaProjection captures the real display, not the app window. Ask
        // DisplayManager first so navigation bars/cutouts are included and
        // the dimensions match the pixels delivered by ScreenCapturerAndroid.
        val display = getSystemService(DisplayManager::class.java)
            ?.getDisplay(Display.DEFAULT_DISPLAY)
        if (display != null) {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION") display.getRealMetrics(metrics)
            if (metrics.widthPixels > 1 && metrics.heightPixels > 1) {
                return NativeDisplayMetrics(
                    metrics.widthPixels,
                    metrics.heightPixels,
                    metrics.densityDpi,
                    display.rotation,
                )
            }
        }

        // Fallback for unusual OEMs that do not expose a Display instance.
        val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = windowManager.maximumWindowMetrics.bounds
            return NativeDisplayMetrics(
                bounds.width(),
                bounds.height(),
                resources.configuration.densityDpi,
                display?.rotation ?: 0,
            )
        }
        @Suppress("DEPRECATION") val legacyDisplay = windowManager.defaultDisplay
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION") legacyDisplay.getRealMetrics(metrics)
        return NativeDisplayMetrics(
            metrics.widthPixels,
            metrics.heightPixels,
            metrics.densityDpi,
            legacyDisplay.rotation,
        )
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

    private data class NativeDisplayMetrics(
        val width: Int,
        val height: Int,
        val densityDpi: Int,
        val rotation: Int,
    )
}
