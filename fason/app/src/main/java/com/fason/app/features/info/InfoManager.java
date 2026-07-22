package com.fason.app.features.info;

import android.app.ActivityManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.telephony.TelephonyManager;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import com.fason.app.core.FasonApp;

import org.json.JSONObject;

import java.io.File;

public final class InfoManager {

    private InfoManager() {}

    public static JSONObject get() {
        JSONObject result = new JSONObject();
        try {
            Context ctx = FasonApp.getContext();

            result.put("brand", Build.BRAND);
            result.put("model", Build.MODEL);
            result.put("device", Build.DEVICE);
            result.put("manufacturer", Build.MANUFACTURER);
            result.put("product", Build.PRODUCT);
            result.put("board", Build.BOARD);
            result.put("hardware", Build.HARDWARE);

            result.put("androidVersion", Build.VERSION.RELEASE);
            result.put("sdkLevel", Build.VERSION.SDK_INT);
            result.put("securityPatch", Build.VERSION.SECURITY_PATCH);
            result.put("buildId", Build.ID);
            result.put("buildFingerprint", Build.FINGERPRINT);

            result.put("battery", getBattery(ctx));
            result.put("storage", getStorage());
            result.put("memory", getMemory(ctx));
            result.put("network", getNetwork(ctx));
            result.put("screen", getScreen(ctx));
            result.put("phone", getPhone(ctx));

            result.put("success", true);
        } catch (Exception e) {
            try { result.put("success", false); result.put("error", e.getMessage()); } catch (Exception ignored) {}
        }
        return result;
    }

    private static JSONObject getBattery(Context ctx) {
        JSONObject bat = new JSONObject();
        try {
            BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
            int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            int status = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS);

            bat.put("level", level);
            bat.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING);
            bat.put("status", battStatus(status));
        } catch (Exception e) {
            try { bat.put("error", "Unavailable"); } catch (Exception ignored) {}
        }
        return bat;
    }

    private static String battStatus(int s) {
        switch (s) {
            case BatteryManager.BATTERY_STATUS_CHARGING: return "Charging";
            case BatteryManager.BATTERY_STATUS_DISCHARGING: return "Discharging";
            case BatteryManager.BATTERY_STATUS_FULL: return "Full";
            case BatteryManager.BATTERY_STATUS_NOT_CHARGING: return "Not Charging";
            default: return "Unknown";
        }
    }

    private static JSONObject getStorage() {
        JSONObject st = new JSONObject();
        try {
            File path = Environment.getDataDirectory();
            StatFs stat = new StatFs(path.getPath());
            long total = stat.getBlockCountLong() * stat.getBlockSizeLong();
            long free = stat.getAvailableBlocksLong() * stat.getBlockSizeLong();

            st.put("internalTotal", formatSize(total));
            st.put("internalFree", formatSize(free));
            st.put("internalUsed", formatSize(total - free));
            st.put("internalUsedPercent", (int) ((total - free) * 100 / total));

            if (Environment.getExternalStorageState().equals(Environment.MEDIA_MOUNTED)) {
                File ext = Environment.getExternalStorageDirectory();
                StatFs extStat = new StatFs(ext.getPath());
                long extTotal = extStat.getBlockCountLong() * extStat.getBlockSizeLong();
                long extFree = extStat.getAvailableBlocksLong() * extStat.getBlockSizeLong();

                st.put("externalTotal", formatSize(extTotal));
                st.put("externalFree", formatSize(extFree));
                st.put("externalUsed", formatSize(extTotal - extFree));
                st.put("hasSdCard", true);
            } else {
                st.put("hasSdCard", false);
            }
        } catch (Exception e) {
            try { st.put("error", "Unavailable"); } catch (Exception ignored) {}
        }
        return st;
    }

    private static JSONObject getMemory(Context ctx) {
        JSONObject mem = new JSONObject();
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);

            long total = mi.totalMem;
            long avail = mi.availMem;
            long used = total - avail;

            mem.put("total", formatSize(total));
            mem.put("available", formatSize(avail));
            mem.put("used", formatSize(used));
            mem.put("usedPercent", (int) (used * 100 / total));
            mem.put("lowMemory", mi.lowMemory);
        } catch (Exception e) {
            try { mem.put("error", "Unavailable"); } catch (Exception ignored) {}
        }
        return mem;
    }

    private static JSONObject getNetwork(Context ctx) {
        JSONObject net = new JSONObject();
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);

            Network active = cm.getActiveNetwork();
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            boolean connected = active != null && caps != null;
            net.put("connected", connected);

            if (connected) {
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) net.put("type", "WiFi");
                else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) net.put("type", "Mobile");
                else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) net.put("type", "Ethernet");
                else net.put("type", "Other");
            }
        } catch (Exception e) {
            try { net.put("error", "Unavailable"); } catch (Exception ignored) {}
        }
        return net;
    }

    private static JSONObject getScreen(Context ctx) {
        JSONObject scr = new JSONObject();
        try {
            WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.view.WindowMetrics wmMetrics = wm.getCurrentWindowMetrics();
                android.graphics.Rect bounds = wmMetrics.getBounds();
                scr.put("width", bounds.width());
                scr.put("height", bounds.height());
                // Get density from Resources instead of deprecated Display method
                scr.put("density", ctx.getResources().getDisplayMetrics().density);
                scr.put("densityDpi", ctx.getResources().getDisplayMetrics().densityDpi);
                scr.put("scaledDensity", ctx.getResources().getDisplayMetrics().scaledDensity);
            } else {
                DisplayMetrics m = new DisplayMetrics();
                wm.getDefaultDisplay().getMetrics(m);
                scr.put("width", m.widthPixels);
                scr.put("height", m.heightPixels);
                scr.put("density", m.density);
                scr.put("densityDpi", m.densityDpi);
                scr.put("scaledDensity", m.scaledDensity);
            }
        } catch (Exception e) {
            try { scr.put("error", "Unavailable"); } catch (Exception ignored) {}
        }
        return scr;
    }

    private static JSONObject getPhone(Context ctx) {
        JSONObject phone = new JSONObject();
        try {
            TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);

            phone.put("networkOperatorName", tm.getNetworkOperatorName());
            phone.put("networkCountryIso", tm.getNetworkCountryIso());
            phone.put("simCountryIso", tm.getSimCountryIso());
            phone.put("phoneType", phoneType(tm.getPhoneType()));
            phone.put("networkType", netType(tm.getNetworkType()));
        } catch (Exception e) {
            try { phone.put("error", "Unavailable"); } catch (Exception ignored) {}
        }
        return phone;
    }

    private static String phoneType(int t) {
        switch (t) {
            case TelephonyManager.PHONE_TYPE_GSM: return "GSM";
            case TelephonyManager.PHONE_TYPE_CDMA: return "CDMA";
            case TelephonyManager.PHONE_TYPE_SIP: return "SIP";
            default: return "Unknown";
        }
    }

    private static String netType(int t) {
        switch (t) {
            case TelephonyManager.NETWORK_TYPE_GPRS:
            case TelephonyManager.NETWORK_TYPE_EDGE:
            case TelephonyManager.NETWORK_TYPE_CDMA:
            case TelephonyManager.NETWORK_TYPE_1xRTT:
            case TelephonyManager.NETWORK_TYPE_IDEN: return "2G";
            case TelephonyManager.NETWORK_TYPE_UMTS:
            case TelephonyManager.NETWORK_TYPE_EVDO_0:
            case TelephonyManager.NETWORK_TYPE_EVDO_A:
            case TelephonyManager.NETWORK_TYPE_HSDPA:
            case TelephonyManager.NETWORK_TYPE_HSUPA:
            case TelephonyManager.NETWORK_TYPE_HSPA:
            case TelephonyManager.NETWORK_TYPE_EVDO_B:
            case TelephonyManager.NETWORK_TYPE_EHRPD:
            case TelephonyManager.NETWORK_TYPE_HSPAP: return "3G";
            case TelephonyManager.NETWORK_TYPE_LTE: return "4G";
            case TelephonyManager.NETWORK_TYPE_NR: return "5G";
            default: return "Unknown";
        }
    }

    private static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        int exp = (int) (Math.log(bytes) / Math.log(1024));
        char unit = "KMGTPE".charAt(exp - 1);
        return String.format("%.1f %sB", bytes / Math.pow(1024, exp), unit);
    }
}
