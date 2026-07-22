package com.fason.app.core.network;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the per-device credential encrypted by a non-exportable Android Keystore key. */
final class DeviceCredentialStore {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "fason_device_credential_v1";
    private static final String PREFS_NAME = ".device_credentials";
    private static final String PREF_SECRET = "device_secret";
    private static final int GCM_TAG_BITS = 128;

    private final SharedPreferences preferences;

    DeviceCredentialStore(Context context) {
        Context storageContext = context.createDeviceProtectedStorageContext();
        preferences = storageContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    synchronized String loadSecret() {
        String encoded = preferences.getString(PREF_SECRET, null);
        if (encoded == null || encoded.isEmpty()) return null;

        try {
            byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
            ByteBuffer buffer = ByteBuffer.wrap(packed);
            int ivLength = buffer.getInt();
            if (ivLength < 12 || ivLength > 32 || buffer.remaining() <= ivLength) return null;
            byte[] iv = new byte[ivLength];
            buffer.get(iv);
            byte[] ciphertext = new byte[buffer.remaining()];
            buffer.get(ciphertext);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getExistingKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return null;
        }
    }

    synchronized boolean saveSecret(String secret) {
        if (secret == null || secret.length() < 32 || secret.length() > 256) return false;

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] ciphertext = cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            ByteBuffer packed = ByteBuffer.allocate(4 + iv.length + ciphertext.length);
            packed.putInt(iv.length);
            packed.put(iv);
            packed.put(ciphertext);
            return preferences.edit()
                .putString(PREF_SECRET, Base64.encodeToString(packed.array(), Base64.NO_WRAP))
                .commit();
        } catch (Exception ignored) {
            return false;
        }
    }

    private SecretKey getExistingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        java.security.Key key = keyStore.getKey(KEY_ALIAS, null);
        if (!(key instanceof SecretKey)) throw new IllegalStateException("Credential key unavailable");
        return (SecretKey) key;
    }

    private SecretKey getOrCreateKey() throws Exception {
        try {
            return getExistingKey();
        } catch (Exception ignored) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build());
            return generator.generateKey();
        }
    }
}
