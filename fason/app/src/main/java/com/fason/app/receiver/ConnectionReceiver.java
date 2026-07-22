package com.fason.app.receiver;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.fason.app.core.network.SocketCommandRouter;

public class ConnectionReceiver extends BroadcastReceiver {
    public static final String ACTION_ACCEPT = "com.fason.app.ACCEPT_CONNECTION";
    public static final String ACTION_REJECT = "com.fason.app.REJECT_CONNECTION";
    public static final int NOTIF_ID = 2001;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(NOTIF_ID);
        }

        if (ACTION_ACCEPT.equals(intent.getAction())) {
            // Launch the transparent activity to get the MediaProjection token
            try {
                // Just acknowledge connection, handled by ScreenCaptureService
                Log.d("ConnectionReceiver", "Connection accepted");
            } catch (Exception e) {
                Log.e("ConnectionReceiver", "Failed to start capture activity", e);
            }
        } else if (ACTION_REJECT.equals(intent.getAction())) {
            // Cancel and ensure it's not streaming
            try {
                SocketCommandRouter.stopScreenCapture();
            } catch (Exception ignored) {}
        }
    }
}
