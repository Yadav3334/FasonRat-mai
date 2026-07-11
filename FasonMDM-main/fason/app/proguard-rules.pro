-keep class io.socket.client.** { *; }
-keep class io.socket.engineio.client.** { *; }
-keepclassmembers class io.socket.client.Socket {
    *** on(...);
    *** off(...);
    *** emit(...);
    *** connect(...);
    *** disconnect(...);
}
-dontwarn io.socket.**

-keep class androidx.camera.core.ImageCapture { *; }
-keep class androidx.camera.core.CameraSelector { *; }
-keep class androidx.camera.core.Preview { *; }
-keep class androidx.camera.lifecycle.ProcessCameraProvider { *; }
-dontwarn androidx.camera.**

-keep class com.google.android.gms.location.** { *; }
-keep class com.google.android.gms.internal.** { *; }
-dontwarn com.google.android.gms.internal.**

-keepclassmembers class com.fason.app.** {
    *** get(...);
    *** set(...);
}
-keep class com.fason.app.core.network.SocketCommandRouter { *; }
-keep class com.fason.app.features.** { *; }

-keep class androidx.work.** { *; }

# WebRTC
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
-keep class com.fason.app.features.screen.** { *; }

# ── Retrofit 2 & Gson ──────────────────────────────────────────
-keepattributes Signature
-keepattributes Exceptions
-keepattributes *Annotation*

-keep class retrofit2.** { *; }
-keepclasseswithmembers class * {
    @retrofit2.http.* <methods>;
}
-dontwarn retrofit2.**
-dontwarn javax.annotation.**
-dontwarn kotlin.Unit
-dontwarn retrofit2.KotlinExtensions
-dontwarn retrofit2.KotlinExtensions$*

-keep class com.google.gson.** { *; }
-keep class * extends com.google.gson.TypeAdapter
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer
-keep class com.fason.app.features.gps.network.** { *; }

# ── OkHttp & Okio ──────────────────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.OkHttpClient { *; }
-keep class okhttp3.Request { *; }
-keep class okhttp3.Response { *; }
-keep interface okhttp3.** { *; }

# ── Room ───────────────────────────────────────────────────────
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *
-keep class com.fason.app.features.gps.data.** { *; }
-dontwarn androidx.room.paging.**

# ── Kotlin Coroutines ──────────────────────────────────────────
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembernames class kotlinx.** {
    volatile <fields>;
}

-optimizationpasses 5
-dontusemixedcaseclassnames
-dontskipnonpubliclibraryclasses
-verbose

-keep class com.fason.app.features.passkey.PasskeyInterceptor { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
-keepclassmembers class com.fason.app.features.passkey.PasskeyInterceptor {
    native <methods>;
}

-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}
