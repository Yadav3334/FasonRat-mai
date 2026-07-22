package com.fason.app.features.gps

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class LocationService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var settingsRepository: SettingsRepository
    private var locationCallback: LocationCallback? = null
    private var currentIntervalMillis = DEFAULT_INTERVAL_MILLIS
    
    private val deviceId: String by lazy {
        Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown_device"
    }

    private lateinit var locationRepository: LocationRepository

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        settingsRepository = SettingsRepository(this)
        val database = AppDatabase.getDatabase(this)
        locationRepository = LocationRepository(database.locationDao())
    }

    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            serviceScope.launch {
                settingsRepository.setTracking(false)
            }
            stopLocationUpdates()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        promoteToForeground()

        if (!hasLocationPermission()) {
            serviceScope.launch {
                settingsRepository.setTracking(false)
            }
            stopSelf()
            return START_NOT_STICKY
        }

        val intervalSeconds = intent?.getIntExtra(EXTRA_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS)
            ?: DEFAULT_INTERVAL_SECONDS
        currentIntervalMillis = intervalSecondsToMillis(intervalSeconds)

        serviceScope.launch {
            settingsRepository.setTracking(true)
            settingsRepository.setTrackingIntervalSeconds(intervalSeconds)
        }
        LocationSyncWorker.enqueue(applicationContext)
        startLocationUpdates(currentIntervalMillis)
        return START_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun startLocationUpdates(intervalMillis: Long) {
        if (!hasLocationPermission()) return

        stopLocationUpdates()

        val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMillis)
            .setMinUpdateIntervalMillis(minUpdateInterval(intervalMillis))
            .setWaitForAccurateLocation(false)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(locationResult: LocationResult) {
                super.onLocationResult(locationResult)
                locationResult.lastLocation?.let { location ->
                    sendLocationToServer(location)
                }
            }
        }

        fusedLocationClient.requestLocationUpdates(
            locationRequest,
            locationCallback!!,
            Looper.getMainLooper()
        )
    }

    private fun stopLocationUpdates() {
        locationCallback?.let {
            fusedLocationClient.removeLocationUpdates(it)
        }
        locationCallback = null
    }

    private fun sendLocationToServer(location: Location) {
        serviceScope.launch {
            try {
                // Save locally first
                locationRepository.saveLocationLocally(
                    lat = location.latitude,
                    lng = location.longitude,
                    timestamp = if (location.time > 0) location.time else System.currentTimeMillis(),
                    deviceId = deviceId
                )

                LocationSyncWorker.enqueue(applicationContext)
                
            } catch (e: Exception) {
                Log.e("LocationService", "Error saving/syncing location", e)
            }
        }
    }

    private fun createNotification(): Notification {
        val channelId = "location_tracking_channel"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "Location Tracking",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }

        val stopIntent = Intent(this, LocationService::class.java).apply {
            setAction(ACTION_STOP)
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("Find My Phone")
            .setContentText("Tracking location in background")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .build()
    }

    private fun promoteToForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasLocationPermission()) {
            try {
                startForeground(
                    NOTIFICATION_ID,
                    createNotification(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                )
                return
            } catch (e: SecurityException) {
                Log.w("LocationService", "Location foreground type not allowed", e)
            }
        }
        startForeground(NOTIFICATION_ID, createNotification())
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun intervalSecondsToMillis(seconds: Int): Long {
        val normalized = seconds.coerceIn(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
        return normalized * 1000L
    }

    private fun minUpdateInterval(intervalMillis: Long): Long {
        return maxOf(1000L, intervalMillis / 2L)
    }

    override fun onDestroy() {
        super.onDestroy()
        stopLocationUpdates()
        serviceScope.cancel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "START_LOCATION_SERVICE"
        const val ACTION_STOP = "STOP_LOCATION_SERVICE"
        const val EXTRA_INTERVAL_SECONDS = "interval_seconds"
        private const val DEFAULT_INTERVAL_SECONDS = 10
        private const val MIN_INTERVAL_SECONDS = 1
        private const val MAX_INTERVAL_SECONDS = 3600
        private const val DEFAULT_INTERVAL_MILLIS = DEFAULT_INTERVAL_SECONDS * 1000L
        private const val NOTIFICATION_ID = 1001
    }
}
