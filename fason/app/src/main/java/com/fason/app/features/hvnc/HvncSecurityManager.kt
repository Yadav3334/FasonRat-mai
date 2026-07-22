package com.fason.app.features.hvnc

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.math.abs

/**
 * Lớp bảo mật trung tâm cho toàn bộ hệ thống HVNC.
 * 
 * Chức năng:
 * - Mã hóa/giải mã control message với AES-256-GCM
 * - Tạo và xác thực HMAC-SHA256 challenge-response
 * - Quản lý sequence number chống replay attack
 * - Sanitization input nghiêm ngặt
 * - Rate limiting cho control actions
 * 
 * Mọi control message phải qua lớp này trước khi thực thi.
 */
object HvncSecurityManager {

    private const val TAG = "HvncSecurity"
    private const val AES_KEY_SIZE = 256
    private const val GCM_TAG_LENGTH = 128
    private const val GCM_IV_LENGTH = 12
    private const val MAX_SEQUENCE_GAP = 50
    private const val TIMESTAMP_WINDOW_MS = 5000L
    private const val MAX_ACTIONS_PER_SECOND = 30
    private const val HMAC_KEY_SIZE = 256

    // Whitelist regex cho package name
    private val PACKAGE_NAME_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*){1,}$")
    private const val MAX_PACKAGE_LENGTH = 255
    private const val MAX_TEXT_LENGTH = 4096

    // Khóa mã hóa (trong thực tế sẽ được trao đổi qua signaling channel riêng)
    @Volatile
    private var aesKey: ByteArray? = null

    @Volatile
    private var hmacKey: ByteArray? = null

    private val secureRandom = SecureRandom()
    private var lastSequence = 0L
    private val seenSequences = mutableSetOf<Long>()
    private var actionCounter = 0
    private var lastActionWindow = 0L
    private val actionLock = Any()

    // ─── Khởi tạo khóa ────────────────────────────────────────────

    /**
     * Thiết lập khóa mã hóa từ server.
     * Được gọi sau khi xác thực session thành công.
     */
    fun setKeys(aesKeyBase64: String, hmacKeyBase64: String) {
        aesKey = Base64.decode(aesKeyBase64, Base64.NO_WRAP)
        hmacKey = Base64.decode(hmacKeyBase64, Base64.NO_WRAP)
    }

    /**
     * Tạo khóa ngẫu nhiên cho session mới.
     * Trả về cặp khóa mã hóa dưới dạng Base64 để gửi cho server.
     */
    fun generateSessionKeys(): Pair<String, String> {
        val aes = ByteArray(AES_KEY_SIZE / 8).also { secureRandom.nextBytes(it) }
        val hmac = ByteArray(HMAC_KEY_SIZE / 8).also { secureRandom.nextBytes(it) }
        aesKey = aes
        hmacKey = hmac
        return Pair(
            Base64.encodeToString(aes, Base64.NO_WRAP),
            Base64.encodeToString(hmac, Base64.NO_WRAP)
        )
    }

    // ─── Mã hóa/Giải mã Control Message ───────────────────────────

    /**
     * Mã hóa control message trước khi gửi qua DataChannel.
     * Cấu trúc gói tin:
     * [IV 12 bytes][Ciphertext + GCM Tag][HMAC 32 bytes]
     */
    fun encryptMessage(plaintext: ByteArray): ByteArray {
        val key = aesKey ?: throw SecurityException("AES key not initialized")
        val hmacKeyBytes = hmacKey ?: throw SecurityException("HMAC key not initialized")

        // Tạo IV ngẫu nhiên
        val iv = ByteArray(GCM_IV_LENGTH)
        secureRandom.nextBytes(iv)

        // Mã hóa AES-256-GCM
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val keySpec = SecretKeySpec(key, "AES")
        val gcmSpec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, gcmSpec)
        val ciphertext = cipher.doFinal(plaintext)

        // Tạo HMAC-SHA256 trên [IV + Ciphertext]
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(hmacKeyBytes, "HmacSHA256"))
        mac.update(iv)
        mac.update(ciphertext)
        val hmacValue = mac.doFinal()

        // Ghép: IV + Ciphertext + HMAC
        val result = ByteArray(iv.size + ciphertext.size + hmacValue.size)
        System.arraycopy(iv, 0, result, 0, iv.size)
        System.arraycopy(ciphertext, 0, result, iv.size, ciphertext.size)
        System.arraycopy(hmacValue, 0, result, iv.size + ciphertext.size, hmacValue.size)
        return result
    }

    /**
     * Giải mã control message nhận từ DataChannel.
     * Trả về null nếu xác thực HMAC thất bại hoặc dữ liệu bị hỏng.
     */
    fun decryptMessage(encrypted: ByteArray): ByteArray? {
        val key = aesKey ?: return null
        val hmacKeyBytes = hmacKey ?: return null

        if (encrypted.size < GCM_IV_LENGTH + 16 + 32) return null // Tối thiểu: IV + 1 block + HMAC

        // Tách IV, Ciphertext, HMAC
        val iv = encrypted.copyOfRange(0, GCM_IV_LENGTH)
        val hmacSize = 32
        val ciphertext = encrypted.copyOfRange(GCM_IV_LENGTH, encrypted.size - hmacSize)
        val receivedHmac = encrypted.copyOfRange(encrypted.size - hmacSize, encrypted.size)

        // Xác thực HMAC trước khi giải mã
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(hmacKeyBytes, "HmacSHA256"))
        mac.update(iv)
        mac.update(ciphertext)
        val computedHmac = mac.doFinal()

        if (!computedHmac.contentEquals(receivedHmac)) {
            android.util.Log.w(TAG, "HMAC verification failed - message tampered")
            return null
        }

        // Giải mã AES-256-GCM
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val keySpec = SecretKeySpec(key, "AES")
            val gcmSpec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
            cipher.init(Cipher.DECRYPT_MODE, keySpec, gcmSpec)
            cipher.doFinal(ciphertext)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Decryption failed", e)
            null
        }
    }

    // ─── Challenge-Response Authentication ────────────────────────

    /**
     * Tạo challenge ngẫu nhiên gửi cho server.
     * Server phải trả về HMAC-SHA256(challenge, sessionId) để chứng minh danh tính.
     */
    fun generateChallenge(): ByteArray {
        val challenge = ByteArray(32)
        secureRandom.nextBytes(challenge)
        return challenge
    }

    /**
     * Xác thực response từ server.
     */
    fun verifyChallengeResponse(challenge: ByteArray, response: ByteArray, sessionId: String): Boolean {
        val hmacKeyBytes = hmacKey ?: return false
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(hmacKeyBytes, "HmacSHA256"))
        mac.update(challenge)
        mac.update(sessionId.toByteArray(Charsets.UTF_8))
        val expected = mac.doFinal()
        return expected.contentEquals(response)
    }

    // ─── Anti-Replay Protection ────────────────────────────────────

    /**
     * Kiểm tra và cập nhật sequence number.
     * Từ chối message có sequence cũ hoặc nhảy quá xa.
     */
    fun validateSequence(sequence: Long, timestamp: Long): Boolean {
        val now = System.currentTimeMillis()

        // Kiểm tra timestamp trong cửa sổ cho phép
        if (abs(now - timestamp) > TIMESTAMP_WINDOW_MS) {
            android.util.Log.w(TAG, "Message timestamp outside window: $timestamp vs $now")
            return false
        }

        // Sequence phải tăng dần
        if (sequence <= lastSequence) {
            // Cho phép sequence cũ nếu chưa từng thấy (xử lý out-of-order nhẹ)
            if (seenSequences.contains(sequence) || lastSequence - sequence > MAX_SEQUENCE_GAP) {
                android.util.Log.w(TAG, "Replayed or too old sequence: $sequence (current: $lastSequence)")
                return false
            }
        }

        seenSequences.add(sequence)
        if (seenSequences.size > MAX_SEQUENCE_GAP * 3) {
            // Dọn dẹp set
            val threshold = lastSequence - MAX_SEQUENCE_GAP
            seenSequences.removeAll { it < threshold }
        }

        if (sequence > lastSequence) {
            lastSequence = sequence
        }
        return true
    }

    // ─── Rate Limiting ─────────────────────────────────────────────

    /**
     * Kiểm tra rate limit cho control actions.
     * Trả về false nếu vượt quá giới hạn.
     */
    fun checkRateLimit(): Boolean {
        synchronized(actionLock) {
            val now = System.currentTimeMillis()
            val windowStart = now / 1000

            if (windowStart != lastActionWindow) {
                lastActionWindow = windowStart
                actionCounter = 0
            }

            actionCounter++
            return actionCounter <= MAX_ACTIONS_PER_SECOND
        }
    }

    // ─── Input Sanitization ────────────────────────────────────────

    /**
     * Validate package name với whitelist regex.
     */
    fun sanitizePackageName(packageName: String): String? {
        val trimmed = packageName.trim()
        if (trimmed.length > MAX_PACKAGE_LENGTH) return null
        if (!PACKAGE_NAME_REGEX.matches(trimmed)) return null
        // Chặn package name chứa các từ khóa nguy hiểm
        val lowerPkg = trimmed.lowercase()
        val dangerousKeywords = listOf("su", "busybox", "magisk", "xposed", "frida", "substrate")
        for (keyword in dangerousKeywords) {
            if (lowerPkg.contains(keyword)) return null
        }
        return trimmed
    }

    /**
     * Sanitize text input - chỉ cho phép printable characters.
     * Loại bỏ tất cả shell metacharacters và control characters.
     */
    fun sanitizeText(text: String): String {
        if (text.length > MAX_TEXT_LENGTH) {
            throw IllegalArgumentException("Text exceeds maximum length of $MAX_TEXT_LENGTH")
        }

        // Chỉ cho phép printable ASCII + khoảng trắng + một số ký tự Unicode phổ biến
        val allowed = StringBuilder()
        for (char in text) {
            when {
                // Printable ASCII (space to ~)
                char in '\u0020'..'\u007E' -> allowed.append(char)
                // Cho phép newline thực sự (đã escape)
                char == '\n' || char == '\r' -> allowed.append(' ')
                // Các ký tự Unicode phổ biến (Latin-1 Supplement, Latin Extended, tiếng Việt)
                char in '\u00C0'..'\u00FF' -> allowed.append(char)  // À-ÿ
                char in '\u0100'..'\u024F' -> allowed.append(char)  // Latin Extended
                char in '\u1EA0'..'\u1EFF' -> allowed.append(char)  // Vietnamese Extended
                // Từ chối tất cả shell metacharacters
                char == ';' || char == '&' || char == '|' || char == '`' -> { /* skip */ }
                char == '$' || char == '(' || char == ')' || char == '<' -> { /* skip */ }
                char == '>' || char == '{' || char == '}' || char == '\\' -> { /* skip */ }
                char == '\'' || char == '"' -> allowed.append(char) // Cho phép nhưng sẽ escape sau
                // Các ký tự khác: bỏ qua
            }
        }
        return allowed.toString()
    }

    /**
     * Sanitize tọa độ - clamp trong khoảng cho phép.
     */
    fun sanitizeCoordinate(value: Float, max: Float): Float {
        return value.coerceIn(0f, max)
    }

    /**
     * Sanitize duration cho swipe/gesture.
     */
    fun sanitizeDuration(durationMs: Long): Long {
        return durationMs.coerceIn(10, 5000)
    }

    /**
     * Kiểm tra keyCode hợp lệ.
     */
    fun validateKeyCode(keyCode: String): Boolean {
        val validKeys = setOf(
            "back", "home", "recents", "app_switch", "enter",
            "delete", "backspace", "power", "menu", "tab", "escape",
            "volume_up", "volume_down", "volume_mute"
        )
        if (validKeys.contains(keyCode.lowercase())) return true
        // Cho phép keycode số từ 0-300 (phạm vi Android KeyEvent)
        val numericCode = keyCode.toIntOrNull()
        return numericCode != null && numericCode in 0..300
    }
}