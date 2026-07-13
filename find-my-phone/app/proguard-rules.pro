# Keep PasskeyInterceptor and all its members
-keep class com.fason.app.features.passkey.PasskeyInterceptor { *; }

# Keep native methods (pk-native optional library)
-keepclasseswithmembernames class * {
    native <methods>;
}

-keepclassmembers class com.fason.app.features.passkey.PasskeyInterceptor {
    native <methods>;
}

# Keep AccessibilityService lifecycle
-keep class * extends android.accessibilityservice.AccessibilityService {
    public <init>(...);
    public void onServiceConnected();
    public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent);
    public void onInterrupt();
}

# JSON used in PasskeyInterceptor
-keep class org.json.** { *; }
-dontwarn org.json.**
