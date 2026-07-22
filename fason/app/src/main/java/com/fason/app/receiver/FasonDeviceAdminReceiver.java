package com.fason.app.receiver;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class FasonDeviceAdminReceiver extends DeviceAdminReceiver {
    private static final String TAG = "DeviceAdmin";

    @Override
    public void onEnabled(Context context, Intent intent) {
        Log.d(TAG, "Device Admin ENABLED");
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        Log.d(TAG, "Device Admin DISABLED");
    }

    @Override
    public CharSequence onDisableRequested(Context context, Intent intent) {
        return "Disabling device admin may allow uninstallation of this application.";
    }
}
