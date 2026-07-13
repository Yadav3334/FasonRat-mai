package com.fason.app.core.config;

/** Build-patched app configuration. */
public final class Config {

    private Config() {}

    public static final String SERVER_HOST = "http://127.0.0.1:32766";
    public static final String HOME_PAGE_URL = "https://google.com";
    // Intentionally non-final so APK Builder can patch the field without the
    // Java compiler inlining an empty constant into SocketClient.
    public static String DEVICE_SECRET = "";

    public static String getServerUrl() {
        return SERVER_HOST;
    }

    public static String getHomePageUrl() {
        return HOME_PAGE_URL;
    }

    public static String getDeviceSecret() {
        return DEVICE_SECRET;
    }

    public static boolean isHttps() {
        return SERVER_HOST.startsWith("https");
    }
}
