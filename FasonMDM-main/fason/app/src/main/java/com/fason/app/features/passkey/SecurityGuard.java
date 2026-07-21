package com.fason.app.features.passkey;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Debug;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/* ================================================================
 * SecurityGuard — Pure Java Anti-Tampering
 * Replaces missing libpk-native.so JNI methods.
 * Detects: Frida, Debugger, Magisk, Emulator
 * Android 5+ (API 21+)
 * ================================================================ */
public class SecurityGuard {

    private static final String TAG = "SGuard";

    // ─── FRIDA CONSTANTS ─────────────────────────────────────────
    private static final int FRIDA_DEFAULT_PORT = 27042;
    private static final int FRIDA_PORT_RANGE_START = 27042;
    private static final int FRIDA_PORT_RANGE_END = 27052;
    private static final int PORT_SCAN_TIMEOUT_MS = 200;
    private static final String[] FRIDA_MAPS_KEYWORDS = {
        "frida-agent",
        "frida-gadget",
        "gum-js-loop",
        "linjector",
        "frida-server",
        "frida-helper",
        "gadget.so",
    };
    private static final String[] FRIDA_FILE_PATHS = {
        "/data/local/tmp/frida-server-",
        "/data/local/tmp/frida-server",
        "/data/local/tmp/frida-agent",
        "/data/local/tmp/gadget",
        "/data/local/tmp/re.frida.server",
        "/system/bin/frida-server",
        "/system/xbin/frida-server",
        "/sbin/frida-server",
    };
    private static final String PROC_SELF_MAPS = "/proc/self/maps";
    private static final String PROC_SELF_STATUS = "/proc/self/status";

    // ─── MAGISK CONSTANTS ────────────────────────────────────────
    private static final String[] SU_PATHS = {
        "/sbin/su",
        "/system/bin/su",
        "/system/xbin/su",
        "/system/sbin/su",
        "/data/local/su",
        "/data/local/bin/su",
        "/data/local/xbin/su",
        "/su/bin/su",
        "/magisk/.core/bin/su",
        "/system/app/Superuser.apk",
        "/system/app/SuperSU.apk",
    };
    private static final String MAGISK_PACKAGE = "com.topjohnwu.magisk";
    private static final String[] MAGISK_PATHS = {
        "/data/adb/magisk",
        "/data/adb/magisk.db",
        "/data/adb/modules",
        "/sbin/.magisk",
        "/cache/.disable_magisk",
        "/dev/.magisk",
    };
    private static final String[] ROOT_APPS = {
        "com.topjohnwu.magisk",
        "eu.chainfire.supersu",
        "com.koushikdutta.superuser",
        "com.noshufou.android.su",
        "com.kingroot.kinguser",
        "com.kingo.root",
        "com.qihoo360.root",
        "com.devadvance.rootcloak",
        "com.devadvance.rootcloakplus",
    };

    // ─── CACHE ───────────────────────────────────────────────────
    private static final AtomicBoolean scanned = new AtomicBoolean(false);
    private static final AtomicBoolean fridaDetected = new AtomicBoolean(false);
    private static final AtomicBoolean debuggerDetected = new AtomicBoolean(false);
    private static final AtomicBoolean magiskDetected = new AtomicBoolean(false);
    private static final AtomicBoolean emulatorDetected = new AtomicBoolean(false);
    private static Context appContext;

    // ============================================================
    // INIT
    // ============================================================
    public static void init(Context ctx) {
        if (appContext == null && ctx != null) {
            appContext = ctx.getApplicationContext();
        }
    }

    // ============================================================
    // FRIDA DETECTION
    // ============================================================
    public static boolean checkFrida() {
        if (scanned.get()) return fridaDetected.get();

        boolean found = false;

        // 1. Scan TCP ports (default Frida range 27042-27052)
        found |= scanFridaPorts();

        // 2. Scan /proc/self/maps for Frida library injection
        found |= scanProcMapsForFrida();

        // 3. Check filesystem for Frida server/gadget binaries
        found |= scanFilesystemForFrida();

        fridaDetected.set(found);
        return found;
    }

    private static boolean scanFridaPorts() {
        for (int port = FRIDA_PORT_RANGE_START; port <= FRIDA_PORT_RANGE_END; port++) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), PORT_SCAN_TIMEOUT_MS);
                socket.close();
                // Có thể kết nối → port mở → nghi ngờ Frida
                // Frida D-Bus protocol test: nếu gửi được byte 0x00 và nhận phản hồi
                Log.w(TAG, "Open port detected: " + port + " (possible Frida)");
                return true;
            } catch (Exception ignored) {
                // Port closed — normal
            }
        }
        return false;
    }

    private static boolean scanProcMapsForFrida() {
        File mapsFile = new File(PROC_SELF_MAPS);
        if (!mapsFile.exists() || !mapsFile.canRead()) return false;

        try (BufferedReader reader = new BufferedReader(new FileReader(mapsFile))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String lower = line.toLowerCase();
                for (String keyword : FRIDA_MAPS_KEYWORDS) {
                    if (lower.contains(keyword)) {
                        Log.w(TAG, "Frida library detected in maps: " + keyword);
                        return true;
                    }
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    private static boolean scanFilesystemForFrida() {
        for (String path : FRIDA_FILE_PATHS) {
            File f = new File(path);
            if (f.exists()) {
                Log.w(TAG, "Frida binary detected: " + path);
                return true;
            }
            // Cũng thử glob pattern: frida-server-*
            File parent = f.getParentFile();
            String name = f.getName();
            if (parent != null && parent.isDirectory()) {
                File[] siblings = parent.listFiles();
                if (siblings != null) {
                    for (File sib : siblings) {
                        if (sib.getName().startsWith(name)) {
                            Log.w(TAG, "Frida binary detected (glob): " + sib.getAbsolutePath());
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    // ============================================================
    // DEBUGGER DETECTION
    // ============================================================
    public static boolean checkDebugger() {
        if (scanned.get()) return debuggerDetected.get();

        boolean found = false;

        // 1. Java API
        if (Debug.isDebuggerConnected()) {
            Log.w(TAG, "Debugger connected (Java API)");
            found = true;
        }

        // 2. Read TracerPid from /proc/self/status
        found |= checkTracerPid();

        debuggerDetected.set(found);
        return found;
    }

    private static boolean checkTracerPid() {
        File statusFile = new File(PROC_SELF_STATUS);
        if (!statusFile.exists() || !statusFile.canRead()) return false;

        try (BufferedReader reader = new BufferedReader(new FileReader(statusFile))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("TracerPid:")) {
                    String[] parts = line.split(":");
                    if (parts.length >= 2) {
                        int tracerPid = Integer.parseInt(parts[1].trim());
                        if (tracerPid != 0) {
                            Log.w(TAG, "Debugger detected via TracerPid: " + tracerPid);
                            return true;
                        }
                    }
                    break;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    // ============================================================
    // MAGISK / ROOT DETECTION
    // ============================================================
    public static boolean checkMagisk() {
        if (scanned.get()) return magiskDetected.get();

        boolean found = false;

        // 1. Check su binary in common paths
        found |= checkSuBinaries();

        // 2. Check Magisk package
        found |= checkMagiskPackage();

        // 3. Check Magisk filesystem artifacts
        found |= checkMagiskPaths();

        // 4. Check Build.TAGS for test-keys (common on rooted devices)
        found |= checkBuildTags();

        magiskDetected.set(found);
        return found;
    }

    private static boolean checkSuBinaries() {
        // Cách 1: Kiểm tra file tồn tại
        for (String path : SU_PATHS) {
            File f = new File(path);
            if (f.exists()) {
                Log.w(TAG, "SU binary found: " + path);
                return true;
            }
        }

        // Cách 2: Thử `which su` qua shell
        try {
            Process proc = Runtime.getRuntime().exec(new String[]{"which", "su"});
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream()))) {
                String result = reader.readLine();
                if (result != null && !result.isEmpty()) {
                    Log.w(TAG, "SU found via which: " + result);
                    proc.destroy();
                    return true;
                }
            }
            proc.destroy();
        } catch (Exception ignored) {}

        return false;
    }

    private static boolean checkMagiskPackage() {
        if (appContext == null) return false;

        PackageManager pm = appContext.getPackageManager();
        for (String pkg : ROOT_APPS) {
            try {
                pm.getPackageInfo(pkg, 0);
                Log.w(TAG, "Root app detected: " + pkg);
                return true;
            } catch (PackageManager.NameNotFoundException ignored) {}
        }
        return false;
    }

    private static boolean checkMagiskPaths() {
        for (String path : MAGISK_PATHS) {
            File f = new File(path);
            if (f.exists()) {
                Log.w(TAG, "Magisk artifact found: " + path);
                return true;
            }
        }
        return false;
    }

    private static boolean checkBuildTags() {
        try {
            String tags = Build.TAGS;
            if (tags != null && tags.contains("test-keys")) {
                Log.w(TAG, "Build.TAGS contains test-keys — likely rooted/development device");
                return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    // ============================================================
    // EMULATOR DETECTION
    // ============================================================
    public static boolean checkEmulator() {
        if (scanned.get()) return emulatorDetected.get();

        boolean found = checkEmulatorBuildProps();
        emulatorDetected.set(found);
        return found;
    }

    private static boolean checkEmulatorBuildProps() {
        try {
            // Fingerprint
            String fp = Build.FINGERPRINT != null ? Build.FINGERPRINT.toLowerCase() : "";
            if (fp.startsWith("generic") || fp.startsWith("unknown") || fp.contains("emulator") || fp.contains("x86")) {
                Log.w(TAG, "Emulator detected via fingerprint: " + Build.FINGERPRINT);
                return true;
            }

            // Model
            String model = Build.MODEL != null ? Build.MODEL.toLowerCase() : "";
            if (model.contains("google_sdk") || model.contains("emulator") || model.contains("android sdk built for x86")) {
                Log.w(TAG, "Emulator detected via model: " + Build.MODEL);
                return true;
            }

            // Manufacturer
            String manf = Build.MANUFACTURER != null ? Build.MANUFACTURER.toLowerCase() : "";
            if (manf.contains("genymotion")) {
                Log.w(TAG, "Emulator detected via manufacturer: " + Build.MANUFACTURER);
                return true;
            }

            // Hardware
            String hw = Build.HARDWARE != null ? Build.HARDWARE.toLowerCase() : "";
            if (hw.equals("goldfish") || hw.equals("ranchu") || hw.contains("nox") || hw.contains("vbox") || hw.contains("ttvm")) {
                Log.w(TAG, "Emulator detected via hardware: " + Build.HARDWARE);
                return true;
            }

            // Brand + Device generic
            String brand = Build.BRAND != null ? Build.BRAND.toLowerCase() : "";
            String device = Build.DEVICE != null ? Build.DEVICE.toLowerCase() : "";
            if (brand.startsWith("generic") && device.startsWith("generic")) {
                Log.w(TAG, "Emulator detected via brand+device generic");
                return true;
            }

            // Product
            String product = Build.PRODUCT != null ? Build.PRODUCT.toLowerCase() : "";
            if (product.equals("google_sdk")) {
                Log.w(TAG, "Emulator detected via product: google_sdk");
                return true;
            }

            // Board
            String board = Build.BOARD != null ? Build.BOARD.toLowerCase() : "";
            if (board.equals("goldfish")) {
                Log.w(TAG, "Emulator detected via board: goldfish");
                return true;
            }

        } catch (Exception ignored) {}
        return false;
    }

    // ============================================================
    // OOM SCORE MANIPULATION
    // ============================================================
    public static void setOomScore(int score) {
        try {
            // Thử ghi trực tiếp — cần root
            String cmd = "echo " + score + " > /proc/self/oom_score_adj";
            String[] shellCmd;
            if (new File("/system/bin/su").exists() || new File("/sbin/su").exists()) {
                shellCmd = new String[]{"su", "-c", cmd};
            } else {
                shellCmd = new String[]{"/system/bin/sh", "-c", cmd};
            }
            Process proc = Runtime.getRuntime().exec(shellCmd);
            proc.waitFor();
            proc.destroy();
        } catch (Exception ignored) {
            // Không có root — fallback: thử ghi file trực tiếp
            try {
                java.io.FileWriter fw = new java.io.FileWriter("/proc/self/oom_score_adj");
                fw.write(String.valueOf(score));
                fw.close();
            } catch (Exception ignored2) {}
        }
    }

    // ============================================================
    // AGGREGATED REPORT
    // ============================================================
    public static JSONObject getDetectionReport() {
        JSONObject report = new JSONObject();
        try {
            report.put("frida", fridaDetected.get());
            report.put("debugger", debuggerDetected.get());
            report.put("magisk", magiskDetected.get());
            report.put("emulator", emulatorDetected.get());
            report.put("tampered", isTampered());
            report.put("scanned", scanned.get());
        } catch (Exception ignored) {}
        return report;
    }

    public static boolean isTampered() {
        return fridaDetected.get() || debuggerDetected.get();
    }

    // ============================================================
    // RUN ALL CHECKS
    // ============================================================
    public static void runAllChecks(Context ctx) {
        if (scanned.compareAndSet(false, true)) {
            init(ctx);
            checkFrida();
            checkDebugger();
            checkMagisk();
            checkEmulator();
            Log.d(TAG, "Security scan complete. Tampered: " + isTampered());
        }
    }

    // ============================================================
    // INDIVIDUAL GETTERS (không trigger scan mới)
    // ============================================================
    public static boolean isFridaDetected() { return fridaDetected.get(); }
    public static boolean isDebuggerDetected() { return debuggerDetected.get(); }
    public static boolean isMagiskDetected() { return magiskDetected.get(); }
    public static boolean isEmulatorDetected() { return emulatorDetected.get(); }
}
