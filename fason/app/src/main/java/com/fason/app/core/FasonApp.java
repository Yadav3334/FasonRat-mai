package com.fason.app.core;

import android.app.Application;
import android.content.Context;
import android.content.Intent;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.fason.app.service.MainService;
import com.fason.app.worker.KeepAliveWorker;

import java.util.concurrent.TimeUnit;

public class FasonApp extends Application {

    private static FasonApp instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        startServices();
    }

    private void startServices() {
        try {
            startForegroundService(new Intent(this, MainService.class));
        } catch (Exception e) {
            android.util.Log.e("FasonApp", "Failed to start MainService", e);
        }

        try {
            PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(
                KeepAliveWorker.class, 15, TimeUnit.MINUTES
            ).build();

            WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                Protocol.WORK_KEEP_ALIVE,
                ExistingPeriodicWorkPolicy.KEEP,
                work
            );
        } catch (Exception e) {
            android.util.Log.e("FasonApp", "Failed to enqueue KeepAliveWorker", e);
        }
    }

    public static Context getContext() {
        if (instance == null) {
            throw new IllegalStateException("FasonApp not initialized");
        }
        return instance.getApplicationContext();
    }
}
