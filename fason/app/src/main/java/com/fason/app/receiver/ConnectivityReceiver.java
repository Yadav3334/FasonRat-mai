package com.fason.app.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Log;

import com.fason.app.core.network.SocketClient;

/**
 * Monitors network connectivity changes.
 * When network becomes available, triggers socket reconnection.
 * When network is lost, logs the disconnection event.
 */
public class ConnectivityReceiver extends BroadcastReceiver {
    private static final String TAG = "Connectivity";

    @Override
    public void onReceive(Context context, Intent intent) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            Log.w(TAG, "ConnectivityManager unavailable");
            return;
        }

        Network active = cm.getActiveNetwork();
        NetworkCapabilities caps = active != null ? cm.getNetworkCapabilities(active) : null;
        boolean isConnected = caps != null &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);

        if (isConnected) {
            String type = "Unknown";
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) type = "WiFi";
            else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) type = "Mobile";
            else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) type = "Ethernet";

            Log.d(TAG, "Network CONNECTED (" + type + ") — triggering socket reconnect");

            // Trigger socket reconnect when network becomes available
            try {
                SocketClient client = SocketClient.getInstance();
                io.socket.client.Socket s = client.getSocket();
                if (s != null && !s.connected()) {
                    s.connect();
                }
            } catch (Exception e) {
                Log.w(TAG, "Socket reconnect failed: " + e.getMessage());
            }
        } else {
            Log.d(TAG, "Network DISCONNECTED");
        }
    }
}
