package com.fason.app.features.screen

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.media.projection.MediaProjectionConfig
import android.os.Build
import android.os.Bundle

class ConnectionRequestActivity : Activity() {

    companion object {
        private const val REQUEST_CODE = 1000
        private const val STATE_PERMISSION_REQUEST_STARTED = "permissionRequestStarted"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        (getSystemService(Context.NOTIFICATION_SERVICE) as? android.app.NotificationManager)?.cancel(1003)

        // A running MediaProjection is reused by WebRtcScreenManager. In that
        // case tapping a stale notification only needs to report readiness.
        if (ScreenCaptureService.isStreaming) {
            WebRtcScreenManager.emitCurrentStatus()
            finish()
            return
        }

        // Keep this Activity in history until the system consent Activity
        // returns. Relaunching the prompt after a configuration restore can
        // discard the result from the prompt that is already visible.
        if (savedInstanceState?.getBoolean(STATE_PERMISSION_REQUEST_STARTED) == true) return

        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val captureIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            projectionManager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            projectionManager.createScreenCaptureIntent()
        }
        startActivityForResult(captureIntent, REQUEST_CODE)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(STATE_PERMISSION_REQUEST_STARTED, true)
        super.onSaveInstanceState(outState)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_CODE && resultCode == RESULT_OK && data != null) {
            val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_START
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                putExtra(ScreenCaptureService.EXTRA_DATA, data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        } else if (requestCode == REQUEST_CODE) {
            WebRtcScreenManager.permissionDenied()
        }
        finish()
    }
}
