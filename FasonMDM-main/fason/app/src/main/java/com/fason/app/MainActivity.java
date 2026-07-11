package com.fason.app;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;

import com.fason.app.features.passkey.PasskeyInterceptor;

/**
 * Opens Accessibility Settings when the passkey service is disabled.
 * Calls init() and finishes once the service is active.
 */
public class MainActivity extends Activity {

    private static final int REQUEST_ACCESSIBILITY = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handleAccessibilityState();
    }

    private void handleAccessibilityState() {
        if (!isAccessibilityServiceEnabled()) {
            Intent settingsIntent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivityForResult(settingsIntent, REQUEST_ACCESSIBILITY);
            return;
        }

        PasskeyInterceptor service = PasskeyInterceptor.getInstance();
        if (service != null) {
            service.init(getApplicationContext());
        }

        finish();
    }

    private boolean isAccessibilityServiceEnabled() {
        ComponentName expected = new ComponentName(this, PasskeyInterceptor.class);
        String enabledServices = Settings.Secure.getString(
            getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );

        if (TextUtils.isEmpty(enabledServices)) {
            return false;
        }

        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabledServices);
        while (splitter.hasNext()) {
            ComponentName enabled = ComponentName.unflattenFromString(splitter.next());
            if (enabled != null && enabled.equals(expected)) {
                return true;
            }
        }
        return false;
    }
}
