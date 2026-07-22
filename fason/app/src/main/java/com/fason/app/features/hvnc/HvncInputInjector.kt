package com.fason.app.features.hvnc

import android.content.Context
import android.graphics.PointF
import android.os.Build
import android.util.Log
import android.view.KeyEvent
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * HvncInputInjector - Tiêm input vào virtual display với bảo mật tối đa:
 * 
 * - Tất cả input đều qua HvncSecurityManager để sanitize
 * - Shell execution được sandbox với timeout cứng
 * - Sử dụng ProcessBuilder thay vì Runtime.exec()
 * - Environment variables được strip để chống injection
 * - Whitelist package name validation
 * - Không log shell command đầy đủ (chỉ log action type)
 */
class HvncInputInjector(
    private val context: Context,
    private val displayTag: String = "default"
) {

    companion object {
        private const val TAG = "HvncInput"
        private const val SHELL_TIMEOUT_SECONDS = 2L
        private const val MAX_SHELL_OUTPUT = 4096
    }

    var displayId: Int = -1

    /**
     * Tap với tọa độ đã được sanitize.
     */
    fun tap(x: Float, y: Float) {
        if (displayId < 0) return
        val safeX = HvncSecurityManager.sanitizeCoordinate(x, 1920f)
        val safeY = HvncSecurityManager.sanitizeCoordinate(y, 3840f)
        execShellInput("tap ${safeX.toInt()} ${safeY.toInt()}")
    }

    /**
     * Swipe với tọa độ và duration đã được sanitize.
     */
    fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 300) {
        if (displayId < 0) return
        val safeSx = HvncSecurityManager.sanitizeCoordinate(startX, 1920f)
        val safeSy = HvncSecurityManager.sanitizeCoordinate(startY, 3840f)
        val safeEx = HvncSecurityManager.sanitizeCoordinate(endX, 1920f)
        val safeEy = HvncSecurityManager.sanitizeCoordinate(endY, 3840f)
        val safeDuration = HvncSecurityManager.sanitizeDuration(durationMs)
        execShellInput("swipe ${safeSx.toInt()} ${safeSy.toInt()} ${safeEx.toInt()} ${safeEy.toInt()} $safeDuration")
    }

    /**
     * Gesture đa điểm với sanitization.
     */
    fun gesture(points: List<PointF>, durationMs: Long) {
        if (displayId < 0 || points.isEmpty()) return
        if (points.size == 1) {
            tap(points[0].x, points[0].y)
            return
        }
        val first = points.first()
        val last = points.last()
        swipe(first.x, first.y, last.x, last.y, durationMs)
    }

    /**
     * Key event với validation keyCode.
     */
    fun keyEvent(keyCode: String) {
        if (displayId < 0) return
        if (!HvncSecurityManager.validateKeyCode(keyCode)) {
            Log.w(TAG, "[$displayTag] Invalid keyCode rejected: $keyCode")
            return
        }
        val androidKeyCode = when (keyCode.lowercase()) {
            "back" -> KeyEvent.KEYCODE_BACK
            "home" -> KeyEvent.KEYCODE_HOME
            "recents", "app_switch" -> KeyEvent.KEYCODE_APP_SWITCH
            "enter" -> KeyEvent.KEYCODE_ENTER
            "delete", "backspace" -> KeyEvent.KEYCODE_DEL
            "power" -> KeyEvent.KEYCODE_POWER
            "menu" -> KeyEvent.KEYCODE_MENU
            "tab" -> KeyEvent.KEYCODE_TAB
            "escape" -> KeyEvent.KEYCODE_ESCAPE
            "volume_up" -> KeyEvent.KEYCODE_VOLUME_UP
            "volume_down" -> KeyEvent.KEYCODE_VOLUME_DOWN
            "volume_mute" -> KeyEvent.KEYCODE_VOLUME_MUTE
            else -> keyCode.toIntOrNull() ?: return
        }
        execShellKeyEvent(androidKeyCode)
    }

    /**
     * Type text với sanitization nghiêm ngặt và escape an toàn.
     * Sử dụng phương pháp escape thay thế: mã hóa text thành base64
     * và decode trong shell để tránh injection hoàn toàn.
     */
    fun typeText(text: String) {
        if (displayId < 0 || text.isEmpty()) return

        // Sanitize text input
        val sanitized = HvncSecurityManager.sanitizeText(text)
        if (sanitized.isEmpty()) return

        // Thay vì escape phức tạp, sử dụng base64 encoding để truyền text an toàn
        val encoded = android.util.Base64.encodeToString(
            sanitized.toByteArray(Charsets.UTF_8),
            android.util.Base64.NO_WRAP
        )
        // Shell command: echo <base64> | base64 -d | input -d <displayId> text
        execShell("echo $encoded | base64 -d | input -d $displayId text")
    }

    /**
     * Launch app với package name validation chặt chẽ.
     */
    fun launchApp(packageName: String) {
        if (displayId < 0) return

        // Validate package name với whitelist
        val safePkg = HvncSecurityManager.sanitizePackageName(packageName)
        if (safePkg == null) {
            Log.w(TAG, "[$displayTag] Invalid package name rejected: $packageName")
            return
        }

        val launchActivity = getLaunchActivity(safePkg)
        if (launchActivity != null) {
            execShell("am start -n $safePkg/$launchActivity --display $displayId")
        } else {
            execShell(
                "am start --display $displayId -a android.intent.action.MAIN " +
                    "-c android.intent.category.LAUNCHER $safePkg"
            )
        }
    }

    /**
     * Close app với package name validation.
     */
    fun closeApp(packageName: String) {
        val safePkg = HvncSecurityManager.sanitizePackageName(packageName) ?: return
        execShell("am force-stop $safePkg")
    }

    /**
     * Điều chỉnh âm lượng.
     */
    fun adjustVolume(direction: String) {
        val keyCode = when (direction.lowercase()) {
            "up" -> KeyEvent.KEYCODE_VOLUME_UP
            "down" -> KeyEvent.KEYCODE_VOLUME_DOWN
            "mute" -> KeyEvent.KEYCODE_VOLUME_MUTE
            else -> return
        }
        execShell("input keyevent $keyCode")
    }

    // ─── Private Methods ───────────────────────────────────────────

    private fun getLaunchActivity(packageName: String): String? {
        return try {
            val pm = context.packageManager
            val intent = pm.getLaunchIntentForPackage(packageName) ?: return null
            intent.component?.className
        } catch (e: Exception) {
            Log.w(TAG, "[$displayTag] Could not resolve launch activity for $packageName")
            null
        }
    }

    private fun execShellInput(inputArgs: String) {
        execShell("input -d $displayId $inputArgs")
    }

    private fun execShellKeyEvent(keyCode: Int) {
        execShell("input -d $displayId keyevent $keyCode")
    }

    /**
     * Sandboxed shell execution với ProcessBuilder.
     * - Timeout cứng 2 giây
     * - Environment variables bị strip
     * - Working directory là app-private
     * - Output bị giới hạn kích thước
     * - Không log command đầy đủ
     */
    private fun execShell(command: String) {
        var process: Process? = null
        try {
            val pb = ProcessBuilder("sh", "-c", command)
                .directory(context.filesDir)  // Working directory an toàn
                .redirectErrorStream(true)

            // Strip environment variables để chống injection
            pb.environment().clear()
            pb.environment()["PATH"] = "/system/bin:/system/xbin"
            pb.environment()["HOME"] = context.filesDir.absolutePath

            process = pb.start()

            // Timeout cứng
            val completed = process.waitFor(SHELL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (!completed) {
                Log.w(TAG, "[$displayTag] Shell command timed out, killing process")
                process.destroyForcibly()
                process.waitFor(1, TimeUnit.SECONDS)
                return
            }

            val exitCode = process.exitValue()
            if (exitCode != 0) {
                val reader = BufferedReader(InputStreamReader(process.inputStream))
                val output = StringBuilder()
                var line: String?
                var totalRead = 0
                while (reader.readLine().also { line = it } != null && totalRead < MAX_SHELL_OUTPUT) {
                    output.append(line).append('\n')
                    totalRead += line!!.length
                }
                reader.close()
                if (output.isNotEmpty()) {
                    // Chỉ log loại action, không log command đầy đủ để tránh lộ thông tin
                    Log.w(TAG, "[$displayTag] Shell action failed (exit=$exitCode)")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "[$displayTag] Shell execution error", e)
        } finally {
            try { process?.destroyForcibly() } catch (_: Exception) {}
        }
    }
}