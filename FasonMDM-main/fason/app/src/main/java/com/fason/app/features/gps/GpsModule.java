package com.fason.app.features.gps;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;

import com.fason.app.core.Protocol;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.atomic.AtomicLong;

public class GpsModule {
    private static final String TAG = "GpsModule";

    private static final long GPS_INTERVAL_MEDIUM = 5000;
    private static final float MIN_DISTANCE = 1.0f;
    private static final int MAX_TRACK_HISTORY = 10000;
    private static final int MAX_TRIGGERED_EVENTS = 1000;
    private static final float MIN_GEOFENCE_RADIUS = 60f;
    private static final long SPOOFING_RESET_TIME_MS = 60_000; // Reset spoofing flag sau 60s

    private final Context ctx;
    private final LocationManager locationManager;
    private final FusedLocationProviderClient fusedClient;
    private final SharedPreferences prefs;

    private LocationCallback fusedCallback;
    private LocationListener gpsListener;
    private LocationListener networkListener;
    private GnssStatus.Callback gnssStatusCallback;

    // --- Thread-Safe Shared State ---
    private volatile Location bestLocation = null;
    private volatile boolean isTracking = false;
    private volatile int satelliteCount = 0;
    private volatile int satelliteUsed = 0;
    private volatile float currentSpeed = 0;
    private volatile float currentBearing = 0;
    private volatile double currentAltitude = 0;
    private volatile long lastUpdateTime = 0;
    private volatile long spoofingDetectedAt = 0;

    private final Object distanceLock = new Object();
    private float totalDistance = 0;

    private final AtomicLong totalLocations = new AtomicLong(0);

    private final List<JSONObject> trackHistory = Collections.synchronizedList(new LinkedList<>());
    private final Map<String, GeoFence> geofences = new ConcurrentHashMap<>();
    
    // Deque cho hiệu suất O(1) khi add/remove đầu danh sách
    private final ConcurrentLinkedDeque<String> triggeredGeofences = new ConcurrentLinkedDeque<>();

    // ThreadLocal formats (Safe & UTC timezone)
    private static final ThreadLocal<SimpleDateFormat> sdf = ThreadLocal.withInitial(() -> {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f;
    });
    private static final ThreadLocal<DecimalFormat> dfCoord = ThreadLocal.withInitial(
            () -> new DecimalFormat("#.0000000")
    );

    private static class GeoFence {
        String id;
        String name;
        double lat;
        double lng;
        float radius;
        volatile boolean isInside = false;

        GeoFence(String id, String name, double lat, double lng, float radius, boolean isInside) {
            this.id = id;
            this.name = name;
            this.lat = lat;
            this.lng = lng;
            this.radius = Math.max(radius, MIN_GEOFENCE_RADIUS);
            this.isInside = isInside;
        }
    }

    public GpsModule(Context context) {
        this.ctx = context.getApplicationContext();
        this.prefs = ctx.getSharedPreferences(".gps_config", Context.MODE_PRIVATE);
        this.locationManager = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        this.fusedClient = LocationServices.getFusedLocationProviderClient(ctx);

        if (locationManager == null) {
            Log.e(TAG, "LocationManager is null. GPS features disabled.");
            return;
        }

        taoLocationCallbacks();
        taoGnssCallbacks();
        taiGeofences();
    }

    private void taoLocationCallbacks() {
        fusedCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                if (locationResult == null) return;
                for (Location location : locationResult.getLocations()) {
                    xuLyLocation(location, "FUSED");
                }
            }
        };

        gpsListener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                xuLyLocation(location, "GPS");
            }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
            @Override public void onProviderEnabled(String provider) {
                // Khi GPS bật lại, chuyển từ Network sang GPS
                if (LocationManager.GPS_PROVIDER.equals(provider)) {
                    chuyenSangGps();
                }
            }
            @Override
            public void onProviderDisabled(String provider) {
                if (LocationManager.GPS_PROVIDER.equals(provider)) {
                    chuyenSangNetworkFallback();
                }
            }
        };

        networkListener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                xuLyLocation(location, "NETWORK");
            }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
            @Override public void onProviderEnabled(String provider) {}
            @Override public void onProviderDisabled(String provider) {}
        };
    }

    @SuppressLint("MissingPermission")
    private void taoGnssCallbacks() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            gnssStatusCallback = new GnssStatus.Callback() {
                @Override
                public void onSatelliteStatusChanged(GnssStatus status) {
                    satelliteCount = status.getSatelliteCount();
                    satelliteUsed = 0;
                    for (int i = 0; i < satelliteCount; i++) {
                        if (status.usedInFix(i)) satelliteUsed++;
                    }
                }
            };
            try {
                locationManager.registerGnssStatusCallback(gnssStatusCallback);
            } catch (SecurityException ignored) {}
        }
    }

    private void xuLyLocation(Location location, String source) {
        if (location == null) return;
        long now = System.currentTimeMillis();

        if (kiemTraSpoofing(location)) {
            spoofingDetectedAt = now;
        }

        // Bỏ qua location quá cũ (10 phút)
        long locationAge = now - location.getTime();
        if (locationAge > 600000) return;

        // Chỉ cập nhật nếu location này tốt hơn location cũ
        if (isBetterLocation(location, bestLocation)) {
            if (bestLocation != null) {
                float distance = location.distanceTo(bestLocation);
                if (distance > 1) {
                    currentBearing = bestLocation.bearingTo(location);
                }
                // Lọc nhiễu GPS: Chỉ cộng khoảng cách nếu dịch chuyển > 0.5m hoặc > 50% độ chính xác
                float minDist = Math.max(0.5f, bestLocation.getAccuracy() * 0.5f);
                if (distance > minDist) {
                    synchronized (distanceLock) {
                        totalDistance += distance;
                    }
                }
            }

            bestLocation = location;
            lastUpdateTime = now;
            currentAltitude = location.getAltitude();
            currentSpeed = location.hasSpeed() ? location.getSpeed() : 0;
        }

        luuTrackHistory(location, source);
        kiemTraGeofence(location);
        totalLocations.incrementAndGet();
    }

    /**
     * Tiêu chí chọn location tốt hơn (dựa trên thời gian và độ chính xác)
     */
    private boolean isBetterLocation(Location location, Location currentBestLocation) {
        if (currentBestLocation == null) return true;

        long timeDelta = location.getTime() - currentBestLocation.getTime();
        boolean isSignificantlyNewer = timeDelta > 10 * 1000;
        boolean isSignificantlyOlder = timeDelta < -10 * 1000;
        boolean isNewer = timeDelta > 0;

        if (isSignificantlyNewer) return true;
        if (isSignificantlyOlder) return false;

        int accuracyDelta = (int) (location.getAccuracy() - currentBestLocation.getAccuracy());
        boolean isLessAccurate = accuracyDelta > 0;
        boolean isMoreAccurate = accuracyDelta < 0;
        boolean isSignificantlyLessAccurate = accuracyDelta > 50;

        if (isMoreAccurate) return true;
        if (isNewer && !isLessAccurate) return true;
        return isNewer && !isSignificantlyLessAccurate;
    }

    private void luuTrackHistory(Location location, String source) {
        try {
            JSONObject point = new JSONObject();
            point.put("lat", dfCoord.get().format(location.getLatitude()));
            point.put("lng", dfCoord.get().format(location.getLongitude()));
            point.put("accuracy", location.getAccuracy());
            point.put("altitude", location.getAltitude());
            point.put("speed", currentSpeed);
            point.put("bearing", currentBearing);
            point.put("provider", location.getProvider());
            point.put("source", source);
            point.put("satellites", satelliteUsed);
            point.put("timestamp", sdf.get().format(new Date(location.getTime())));

            synchronized (trackHistory) {
                while (trackHistory.size() >= MAX_TRACK_HISTORY && !trackHistory.isEmpty()) {
                    trackHistory.remove(0);
                }
                trackHistory.add(point);
            }
        } catch (Exception ignored) {}
    }

    private boolean kiemTraSpoofing(Location location) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (location.isMock()) return true;
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
            if (location.isFromMockProvider()) return true;
        }
        if (location.hasSpeed() && location.getSpeed() > 83.33f) return true; // > 300 km/h
        return false;
    }

    private void kiemTraGeofence(Location location) {
        for (GeoFence gf : geofences.values()) {
            // Pre-filter bằng Bounding Box để giảm tải tính toán (tránh gọi distanceBetween không cần thiết)
            double latDiff = Math.abs(location.getLatitude() - gf.lat);
            double lngDiff = Math.abs(location.getLongitude() - gf.lng);
            // 1 độ vĩ độ ~ 111km. Threshold = (radius + 150m) / 111000m
            double threshold = (gf.radius + 151) / 111000.0; 
            if (latDiff > threshold || lngDiff > threshold) continue;

            float[] results = new float[1];
            Location.distanceBetween(location.getLatitude(), location.getLongitude(), gf.lat, gf.lng, results);
            float distance = results[0];

            if (!gf.isInside && distance <= gf.radius - 50) {
                gf.isInside = true;
                String event = "GEOFENCE_ENTER:" + gf.name;
                addTriggeredEvent(event);
                luuGeofences(); // Lưu trạng thái isInside
                Log.d(TAG, event);
            } else if (gf.isInside && distance > gf.radius + 150) {
                gf.isInside = false;
                String event = "GEOFENCE_EXIT:" + gf.name;
                addTriggeredEvent(event);
                luuGeofences(); // Lưu trạng thái isInside
                Log.d(TAG, event);
            }
        }
    }

    private void addTriggeredEvent(String event) {
        while (triggeredGeofences.size() >= MAX_TRIGGERED_EVENTS) {
            triggeredGeofences.pollFirst(); // O(1) trên Deque
        }
        triggeredGeofences.addLast(event);
    }

    @SuppressLint("MissingPermission")
    private void chuyenSangNetworkFallback() {
        try {
            if (locationManager != null && locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 10, networkListener);
            }
        } catch (SecurityException ignored) {}
    }

    @SuppressLint("MissingPermission")
    private void chuyenSangGps() {
        try {
            if (locationManager != null && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.removeUpdates(networkListener);
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_INTERVAL_MEDIUM, MIN_DISTANCE, gpsListener);
            }
        } catch (SecurityException ignored) {}
    }

    @SuppressLint("MissingPermission")
    public void startTracking() {
        if (isTracking || locationManager == null) return;
        isTracking = true;

        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_INTERVAL_MEDIUM, MIN_DISTANCE, gpsListener);
            } else {
                chuyenSangNetworkFallback();
            }

            LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, GPS_INTERVAL_MEDIUM)
                    .setMinUpdateIntervalMillis(2000)
                    .setWaitForAccurateLocation(false)
                    .build();
            fusedClient.requestLocationUpdates(req, fusedCallback, Looper.getMainLooper());
        } catch (SecurityException ignored) {}
    }

    public void stopTracking() {
        if (!isTracking) return;
        isTracking = false;

        try {
            if (locationManager != null) {
                locationManager.removeUpdates(gpsListener);
                locationManager.removeUpdates(networkListener);
            }
            fusedClient.removeLocationUpdates(fusedCallback);
        } catch (Exception ignored) {}
    }

    public void themGeofence(String id, String name, double lat, double lng, float radius) {
        geofences.put(id, new GeoFence(id, name, lat, lng, radius, false));
        luuGeofences();
    }

    public void xoaGeofence(String id) {
        geofences.remove(id);
        luuGeofences();
    }

    private void luuGeofences() {
        try {
            JSONArray arr = new JSONArray();
            for (GeoFence gf : geofences.values()) {
                JSONObject obj = new JSONObject();
                obj.put("id", gf.id);
                obj.put("name", gf.name);
                obj.put("lat", gf.lat);
                obj.put("lng", gf.lng);
                obj.put("radius", gf.radius);
                obj.put("isInside", gf.isInside); // Lưu trạng thái để khôi phục
                arr.put(obj);
            }
            prefs.edit().putString("geofences", arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void taiGeofences() {
        String saved = prefs.getString("geofences", "");
        if (saved.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(saved);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject gf = arr.getJSONObject(i);
                String id = gf.getString("id");
                geofences.put(id, new GeoFence(
                        id, gf.getString("name"),
                        gf.getDouble("lat"), gf.getDouble("lng"),
                        (float) gf.getDouble("radius"),
                        gf.optBoolean("isInside", false)
                ));
            }
        } catch (Exception ignored) {}
    }

    public JSONObject getData() {
        JSONObject data = new JSONObject();
        try {
            Location loc = bestLocation; // Snapshot tránh NPE
            if (loc != null) {
                data.put(Protocol.KEY_ENABLED, true);
                data.put(Protocol.KEY_LATITUDE, loc.getLatitude());
                data.put(Protocol.KEY_LONGITUDE, loc.getLongitude());
                data.put(Protocol.KEY_ACCURACY, loc.getAccuracy());
                data.put(Protocol.KEY_SPEED, currentSpeed);
                data.put(Protocol.KEY_PROVIDER, loc.getProvider());
                data.put(Protocol.KEY_TIMESTAMP, sdf.get().format(new Date(loc.getTime())));
                data.put("altitude", currentAltitude);
                data.put("bearing", currentBearing);
                data.put("satellites", satelliteUsed);
                synchronized (distanceLock) {
                    data.put("totalDistance", totalDistance);
                }
            } else {
                data.put(Protocol.KEY_ENABLED, false);
                data.put(Protocol.KEY_ERROR, "No location");
            }
        } catch (Exception e) {
            try { data.put(Protocol.KEY_ENABLED, false); data.put(Protocol.KEY_ERROR, e.getMessage()); } catch (Exception ignored) {}
        }
        return data;
    }

    public JSONObject getTrackHistory() {
        JSONObject result = new JSONObject();
        try {
            JSONArray arr = new JSONArray();
            synchronized (trackHistory) {
                for (JSONObject pt : trackHistory) arr.put(pt);
            }
            result.put("points", arr);
            result.put("count", trackHistory.size());
            synchronized (distanceLock) {
                result.put("totalDistance", totalDistance);
            }
            
            boolean currentlySpoofing = (System.currentTimeMillis() - spoofingDetectedAt) < SPOOFING_RESET_TIME_MS;
            result.put("spoofingDetected", currentlySpoofing);
        } catch (Exception ignored) {}
        return result;
    }

    public JSONObject getGeofences() {
        JSONObject result = new JSONObject();
        try {
            JSONArray arr = new JSONArray();
            for (GeoFence gf : geofences.values()) {
                JSONObject obj = new JSONObject();
                obj.put("id", gf.id);
                obj.put("name", gf.name);
                obj.put("lat", gf.lat);
                obj.put("lng", gf.lng);
                obj.put("radius", gf.radius);
                obj.put("isInside", gf.isInside);
                arr.put(obj);
            }
            result.put("geofences", arr);
            result.put("triggeredEvents", new JSONArray(triggeredGeofences));
        } catch (Exception ignored) {}
        return result;
    }

    public JSONObject getAdvancedData() {
        JSONObject data = getData();
        try {
            data.put("totalLocations", totalLocations.get());
            data.put("satelliteCount", satelliteCount);
            data.put("satelliteUsed", satelliteUsed);
            data.put("trackHistoryCount", trackHistory.size());
            data.put("geofenceCount", geofences.size());
            data.put("isTracking", isTracking);
        } catch (Exception ignored) {}
        return data;
    }

    // --- Extensibility Helpers ---
    public void clearTrackHistory() {
        synchronized (trackHistory) {
            trackHistory.clear();
        }
    }

    public void resetTotalDistance() {
        synchronized (distanceLock) {
            totalDistance = 0f;
        }
    }

    public void clearTriggeredEvents() {
        triggeredGeofences.clear();
    }

    public void destroy() {
        stopTracking();
        if (gnssStatusCallback != null && locationManager != null) {
            try {
                locationManager.unregisterGnssStatusCallback(gnssStatusCallback);
            } catch (Exception ignored) {}
        }
    }
}