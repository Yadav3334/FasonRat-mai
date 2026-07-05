package com.fason.app.features.gps

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import com.fason.app.R
import com.fason.app.features.gps.data.LocationDatabase
import com.fason.app.features.gps.data.LocationEntity
import com.fason.app.features.gps.network.LocationPayload
import com.fason.app.features.gps.network.RetrofitClient
import com.fason.app.features.gps.ui.GpsTrackerActivity
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

class LocationTrackingService : Service() {

    companion object {
        private const val TAG = "LocationTrackingSvc"
        private const val NOTIF_CHANNEL_ID = "gps_tracker_channel"
        private const val NOTIF_CHANNEL_NAME = "GPS Tracking"
        private const val NOTIF_ID = 1001
        private const val LOCATION_INTERVAL_MS = 10_000L

        const val ACTION_START = "com.fason.app.gps.START"
        const val ACTION_STOP  = "com.fason.app.gps.STOP"
    }

    private lateinit var fusedClient: FusedLocationProviderClient
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var db: LocationDatabase

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val locationCallback: LocationCallback = createLocationCallback()
    private val networkCallback: ConnectivityManager.NetworkCallback = createNetworkCallback()

    @Volatile
    private var isNetworkAvailable: Boolean = false

    // ── Lifecycle ──────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        db = LocationDatabase.getInstance(this)
        createNotificationChannel()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startForegroundNotification()
                startLocationUpdates()
            }
            ACTION_STOP -> {
                stopLocationUpdates()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopLocationUpdates()
        unregisterNetworkCallback()
        serviceScope.cancel()
        LocationDatabase.destroyInstance()
        super.onDestroy()
    }

    // ── Notification ──────────────────────────────────────────────

    private fun createNotificationChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.getNotificationChannel(NOTIF_CHANNEL_ID)?.let { return }
        val channel = android.app.NotificationChannel(
            NOTIF_CHANNEL_ID,
            NOTIF_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "GPS Tracking Service"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun startForegroundNotification() {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, GpsTrackerActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("GPS Tracking Active")
            .setContentText("Sending location updates to server")
            .setSmallIcon(R.drawable.ic_notif_stealth)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        try {
            // Android 14+ (API 34+): must pass foregroundServiceType explicitly
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "Foreground service location type denied", e)
            startForeground(NOTIF_ID, notification)
        }
    }

    // ── Location Updates ──────────────────────────────────────────

    @Suppress("MissingPermission")
    private fun startLocationUpdates() {
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
            .setMinUpdateIntervalMillis(5000L)
            // false = works on emulators without real GPS hardware
            .setWaitForAccurateLocation(false)
            .build()

        try {
            fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
            Log.d(TAG, "Location updates started — interval=${LOCATION_INTERVAL_MS}ms")
        } catch (e: SecurityException) {
            Log.e(TAG, "Location permission denied", e)
        }
    }

    private fun stopLocationUpdates() {
        try {
            fusedClient.removeLocationUpdates(locationCallback)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop location updates", e)
        }
    }

    private fun createLocationCallback(): LocationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            for (location in result.locations) {
                handleLocationUpdate(location)
            }
        }
    }

    private fun handleLocationUpdate(location: Location) {
        val entity = LocationEntity(
            latitude = location.latitude,
            longitude = location.longitude,
            timestamp = location.time,
            speed = if (location.hasSpeed()) location.speed else 0f,
            bearing = location.bearing
        )

        if (isNetworkAvailable) {
            sendToServer(entity)
        } else {
            cacheToDatabase(entity)
        }
    }

    // ── Networking (Retrofit) ──────────────────────────────────────

    private fun sendToServer(entity: LocationEntity) {
        serviceScope.launch {
            try {
                val payload = LocationPayload(
                    latitude = entity.latitude,
                    longitude = entity.longitude,
                    timestamp = entity.timestamp,
                    speed = entity.speed,
                    bearing = entity.bearing
                )
                val response = RetrofitClient.apiService.sendLocation(payload)
                if (response.isSuccessful) {
                    Log.d(TAG, "Location sent OK: ${entity.latitude}, ${entity.longitude}")
                } else {
                    Log.w(TAG, "Server error ${response.code()} — caching")
                    cacheToDatabase(entity)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Network error: ${e.message} — caching")
                cacheToDatabase(entity)
            }
        }
    }

    // ── Room Offline Cache ─────────────────────────────────────────

    private fun cacheToDatabase(entity: LocationEntity) {
        serviceScope.launch {
            try {
                db.locationDao().insert(entity)
                Log.d(TAG, "Cached — pending: ${db.locationDao().count()}")
            } catch (e: Exception) {
                Log.e(TAG, "Room cache failed", e)
            }
        }
    }

    private fun syncPendingLocations() {
        serviceScope.launch {
            try {
                val pending = db.locationDao().getAllPending()
                if (pending.isEmpty()) {
                    Log.d(TAG, "No pending locations to sync")
                    return@launch
                }
                Log.d(TAG, "Syncing ${pending.size} cached locations...")
                for (entity in pending) {
                    try {
                        val payload = LocationPayload(
                            latitude = entity.latitude,
                            longitude = entity.longitude,
                            timestamp = entity.timestamp,
                            speed = entity.speed,
                            bearing = entity.bearing
                        )
                        val response = RetrofitClient.apiService.sendLocation(payload)
                        if (response.isSuccessful) {
                            db.locationDao().deleteById(entity.id)
                        } else {
                            Log.w(TAG, "Sync halted — server ${response.code()}")
                            break
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Sync paused — net: ${e.message}")
                        break
                    }
                }
                Log.d(TAG, "Sync done — remaining: ${db.locationDao().count()}")
            } catch (e: Exception) {
                Log.e(TAG, "Sync failed", e)
            }
        }
    }

    // ── Network Monitoring (NetworkCallback, API 21+) ──────────────

    private fun createNetworkCallback(): ConnectivityManager.NetworkCallback =
        object : ConnectivityManager.NetworkCallback() {

            override fun onAvailable(network: Network) {
                Log.d(TAG, "Network available — syncing")
                isNetworkAvailable = true
                syncPendingLocations()
            }

            override fun onLost(network: Network) {
                Log.d(TAG, "Network lost")
                isNetworkAvailable = false
            }

            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities
            ) {
                val hasInternet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                val isValidated = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                } else {
                    true
                }
                isNetworkAvailable = hasInternet && isValidated
                if (isNetworkAvailable) {
                    syncPendingLocations()
                }
            }
        }

    private fun registerNetworkCallback() {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivityManager.registerNetworkCallback(request, networkCallback)
    }

    private fun unregisterNetworkCallback() {
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister network callback", e)
        }
    }
}
