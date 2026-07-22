import { useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, NotificationEntry, NotificationStatus } from '@/types';
import { CMD } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bell, Eye, Pin, XCircle } from 'lucide-react';

export default function NotificationsPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<{
    notifications: NotificationEntry[];
    status: NotificationStatus | null;
  }>({
    clientId,
    page: 'notifications',
    extractData: (d) => ({
      notifications: Array.isArray(d.list) ? d.list : [],
      status: (d.status as NotificationStatus) || null,
    }),
    dataType: 'notifications',
    defaultValue: { notifications: [], status: null },
  });

  const notifications = rawData.notifications;
  const notifStatus = rawData.status;

  const requestAccess = useCallback(async () => {
    await sendCommand(CMD.NOTIFICATIONS, { action: 'request' });
  }, [sendCommand]);

  const checkStatus = useCallback(async () => {
    await sendCommand(CMD.NOTIFICATIONS, { action: 'status' });
  }, [sendCommand]);

  const statusBadge = notifStatus
    ? notifStatus.enabled && notifStatus.connected
      ? { label: 'Connected', status: 'success' as const }
      : notifStatus.enabled
        ? { label: 'Disconnected', status: 'warning' as const }
        : { label: 'Disabled', status: 'danger' as const }
    : null;

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Notifications"
        subtitle={`${notifications.length} notifications`}
        actions={[
          { label: 'Enable', icon: Bell, onClick: requestAccess, disabled: loading || !online },
          { label: 'Status', icon: Eye, onClick: checkStatus, disabled: loading || !online, variant: 'outline' },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {statusBadge && (
        <StatusBadge label={statusBadge.label} status={statusBadge.status} />
      )}

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={5} />
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications"
          description="Click Enable to request notification access"
          action={{ label: 'Enable', onClick: requestAccess, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <div className="space-y-2">
          {notifications.map((notif, i) => (
            <Card key={`notif-${notif.timestamp || i}`} className="shadow-none">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium">{notif.appName || 'Unknown App'}</p>
                      {notif.ongoing && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 border-warning/30 text-warning bg-warning/5">
                          <Pin className="h-2.5 w-2.5 mr-0.5" />Ongoing
                        </Badge>
                      )}
                      {!notif.clearable && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 border-destructive/30 text-destructive bg-destructive/5">
                          <XCircle className="h-2.5 w-2.5 mr-0.5" />Non-clearable
                        </Badge>
                      )}
                      {notif.category && (
                        <Badge variant="secondary" className="text-[9px] px-1 py-0">{notif.category}</Badge>
                      )}
                    </div>
                    <p className="text-sm">{notif.title || ''}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{notif.content || ''}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">{notif.timestamp || ''}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
