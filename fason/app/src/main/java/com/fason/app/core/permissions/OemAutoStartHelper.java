package com.fason.app.core.permissions;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import android.text.TextUtils;

import com.fason.app.core.Protocol;

/**
 * Opens OEM-specific auto-start settings. Chinese and some other OEMs
 * aggressively kill background services unless the user manually enables
 * auto-start permission.
 */
public final class OemAutoStartHelper {

    private OemAutoStartHelper() {}

    public static boolean isAutoStartNeeded(Context ctx) {
        String mfr = Build.MANUFACTURER.toLowerCase();
        return isKnownOem(mfr) && !hasBeenPrompted(ctx);
    }

    public static boolean isKnownOem(String mfr) {
        if (TextUtils.isEmpty(mfr)) return false;
        return mfr.contains("xiaomi") || mfr.contains("redmi") || mfr.contains("poco") ||
               mfr.contains("huawei") || mfr.contains("honor") ||
               mfr.contains("oppo") || mfr.contains("realme") || mfr.contains("oneplus") ||
               mfr.contains("vivo") || mfr.contains("meizu") || mfr.contains("asus") ||
               mfr.contains("lenovo") || mfr.contains("zte") || mfr.contains("samsung") ||
               mfr.contains("htc");
    }

    public static boolean requestAutoStart(Activity act) {
        Intent intent = getAutoStartIntent(act);
        if (intent != null) {
            try {
                act.startActivity(intent);
                markPrompted(act, true);
                return true;
            } catch (Exception e) {
                return openBatteryOptimization(act);
            }
        }
        return openBatteryOptimization(act);
    }

    private static Intent getAutoStartIntent(Context ctx) {
        String mfr = Build.MANUFACTURER.toLowerCase();

        if (mfr.contains("xiaomi") || mfr.contains("redmi") || mfr.contains("poco")) {
            return xiaomiIntent(ctx);
        }
        if (mfr.contains("huawei") || mfr.contains("honor")) {
            return huaweiIntent(ctx);
        }
        if (mfr.contains("oppo") || mfr.contains("realme")) {
            return oppoIntent(ctx);
        }
        if (mfr.contains("oneplus")) {
            return onePlusIntent(ctx);
        }
        if (mfr.contains("vivo")) {
            return vivoIntent(ctx);
        }
        if (mfr.contains("meizu")) {
            return meizuIntent(ctx);
        }
        if (mfr.contains("samsung")) {
            return samsungIntent();
        }
        if (mfr.contains("asus")) {
            return asusIntent();
        }
        if (mfr.contains("lenovo") || mfr.contains("zte")) {
            return lenovoIntent();
        }
        if (mfr.contains("htc")) {
            return htcIntent();
        }
        return null;
    }

    // OEM-specific intents

    private static Intent xiaomiIntent(Context ctx) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.miui.securitycenter",
            "com.miui.permcenter.autostart.AutoStartManagementActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.miui.securitycenter",
            "com.miui.permcenter.permissions.PermissionsEditorActivity"));
        if (canResolve(ctx, i)) return i;

        return null;
    }

    private static Intent huaweiIntent(Context ctx) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.huawei.systemmanager",
            "com.huawei.systemmanager.optimize.process.ProtectActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.huawei.systemmanager",
            "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
        if (canResolve(ctx, i)) return i;

        return null;
    }

    private static Intent oppoIntent(Context ctx) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.coloros.safecenter",
            "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.coloros.safecenter",
            "com.coloros.safecenter.startupapp.StartupAppListActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.oppo.safe",
            "com.oppo.safe.permission.startup.StartupAppListActivity"));
        if (canResolve(ctx, i)) return i;

        return null;
    }

    private static Intent onePlusIntent(Context ctx) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.oneplus.security",
            "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.coloros.safecenter",
            "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
        if (canResolve(ctx, i)) return i;

        return null;
    }

    private static Intent vivoIntent(Context ctx) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.vivo.abe",
            "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.iqoo.secure",
            "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"));
        if (canResolve(ctx, i)) return i;

        i.setComponent(new ComponentName(
            "com.iqoo.secure",
            "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"));
        if (canResolve(ctx, i)) return i;

        return null;
    }

    private static Intent meizuIntent(Context ctx) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.meizu.safe",
            "com.meizu.safe.security.SHOW_APPSEC"));
        i.putExtra("packageName", ctx.getPackageName());
        i.addCategory(Intent.CATEGORY_DEFAULT);
        return i;
    }

    private static Intent samsungIntent() {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.samsung.android.lool",
            "com.samsung.android.sm.ui.battery.BatteryActivity"));
        if (canResolve(i)) return i;

        i.setComponent(new ComponentName(
            "com.samsung.android.sm",
            "com.samsung.android.sm.ui.battery.BatteryActivity"));
        if (canResolve(i)) return i;

        i.setComponent(new ComponentName(
            "com.samsung.android.sm",
            "com.samsung.android.sm.ui.sleepingapps.SleepingAppsActivity"));
        if (canResolve(i)) return i;

        return null;
    }

    private static Intent asusIntent() {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.asus.mobilemanager",
            "com.asus.mobilemanager.powersaver.PowerSaverSettings"));
        if (canResolve(i)) return i;

        i.setComponent(new ComponentName(
            "com.asus.mobilemanager",
            "com.asus.mobilemanager.autostart.AutoStartActivity"));
        if (canResolve(i)) return i;

        return null;
    }

    private static Intent lenovoIntent() {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.lenovo.security",
            "com.lenovo.security.purebackground.PureBackgroundActivity"));
        if (canResolve(i)) return i;

        i.setComponent(new ComponentName(
            "com.zte.heartyservice",
            "com.zte.heartyservice.autorun.AutoRunManagerActivity"));
        if (canResolve(i)) return i;

        return null;
    }

    private static Intent htcIntent() {
        Intent i = new Intent();
        i.setComponent(new ComponentName(
            "com.htc.cs.pns",
            "com.htc.cs.pns.settings.Preferences"));
        return i;
    }

    private static boolean canResolve(Context ctx, Intent i) {
        try {
            return ctx.getPackageManager().resolveActivity(i, 0) != null;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean canResolve(Intent i) {
        try {
            return canResolve(com.fason.app.core.FasonApp.getContext(), i);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean openBatteryOptimization(Activity act) {
        try {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            act.startActivity(i);
            markPrompted(act, true);
            return true;
        } catch (Exception e) {
            try {
                act.startActivity(new Intent(Settings.ACTION_SETTINGS));
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    private static boolean hasBeenPrompted(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(Protocol.PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(Protocol.PREF_AUTOSTART_PROMPTED, false);
    }

    private static void markPrompted(Context ctx, boolean prompted) {
        SharedPreferences prefs = ctx.getSharedPreferences(Protocol.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(Protocol.PREF_AUTOSTART_PROMPTED, prompted).apply();
    }

    public static void resetPrompted(Context ctx) {
        markPrompted(ctx, false);
    }
}
