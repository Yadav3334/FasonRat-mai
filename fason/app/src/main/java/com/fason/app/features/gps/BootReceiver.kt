package com.fason.app.features.gps

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (
            action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            try {
                LocationSyncWorker.enqueue(context)
            } catch (e: Exception) {
                // Ignore boot-time storage races; socket reconnect will enqueue another sync.
            }
            val settingsRepository = SettingsRepository(context)
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val isTracking = settingsRepository.isTracking.first()
                    if (isTracking) {
                        val intervalSeconds = settingsRepository.trackingIntervalSeconds.first()
                        val serviceIntent = Intent(context, LocationService::class.java).apply {
                            setAction(LocationService.ACTION_START)
                            putExtra(LocationService.EXTRA_INTERVAL_SECONDS, intervalSeconds)
                        }
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            context.startForegroundService(serviceIntent)
                        } else {
                            context.startService(serviceIntent)
                        }
                    }
                } catch (e: Exception) {
                    // Best-effort restore; MainService/socket reconnect can restore tracking too.
                }
            }
        }
    }
}
