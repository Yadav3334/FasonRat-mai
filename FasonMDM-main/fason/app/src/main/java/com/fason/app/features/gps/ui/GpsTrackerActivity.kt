package com.fason.app.features.gps.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.fason.app.R
import com.fason.app.features.gps.LocationTrackingService

class GpsTrackerActivity : ComponentActivity() {

    companion object {
        /**
         * Permission list for Android 10 (API 29) through Android 16 (API 36+).
         *
         *  ACCESS_FINE_LOCATION     — precise GPS (all versions)
         *  ACCESS_COARSE_LOCATION   — approximate network location (all versions)
         *  ACCESS_BACKGROUND_LOCATION — Android 10-12 only (API 29-32).
         *    On Android 13+ the system bundles foreground+background into one prompt.
         *  POST_NOTIFICATIONS       — Android 13+ for the foreground notification.
         *
         *  FOREGROUND_SERVICE & FOREGROUND_SERVICE_LOCATION are normal manifest
         *  permissions — no runtime prompt needed.
         */
        private val REQUIRED_PERMISSIONS: Array<String> = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)

            if (Build.VERSION.SDK_INT in Build.VERSION_CODES.Q..Build.VERSION_CODES.S_V2) {
                add(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.toTypedArray()
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        val allGranted = results.values.all { it }
        Toast.makeText(
            this,
            if (allGranted) "All permissions granted" else "Some permissions were denied",
            Toast.LENGTH_SHORT
        ).show()
        startTracking()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_gps_tracker)

        findViewById<Button>(R.id.btnStartTracking).setOnClickListener {
            requestPermissionsAndStart()
        }

        findViewById<Button>(R.id.btnStopTracking).setOnClickListener {
            stopTracking()
        }
    }

    private fun requestPermissionsAndStart() {
        val missing = REQUIRED_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isEmpty()) {
            startTracking()
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun startTracking() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        Toast.makeText(this, "Tracking started", Toast.LENGTH_SHORT).show()
    }

    private fun stopTracking() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_STOP
        }
        startService(intent)
        Toast.makeText(this, "Tracking stopped", Toast.LENGTH_SHORT).show()
    }
}
