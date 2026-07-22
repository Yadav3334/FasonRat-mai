import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, SmsMessage } from '@/types';
import { CMD, normalizeSmsList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, LoadingSkeleton } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { MessageSquare } from 'lucide-react';

/** Threshold in ms — messages with a date within this window are considered "new" */
const NEW_SMS_THRESHOLD_MS = 60_000;

function isNewSms(dateStr: string): boolean {
  if (!dateStr) return false;
  const ts = Number(dateStr);
  if (isNaN(ts)) return false;
  return Date.now() - ts < NEW_SMS_THRESHOLD_MS;
}

export default function SmsPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const prevCountRef = useRef(0);
  const [highlightCount, setHighlightCount] = useState(0);

  const { data: smsList, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<SmsMessage[]>({
    clientId,
    page: 'sms',
    extractData: (d) => normalizeSmsList(extractList(d.list)),
    dataType: 'sms',
    defaultValue: [],
    socketDebounceMs: 500, // Fast response for real-time SMS push
  });

  // Track new messages arriving via real-time push
  useEffect(() => {
    if (smsList.length > prevCountRef.current && prevCountRef.current > 0) {
      const newCount = smsList.length - prevCountRef.current;
      setHighlightCount(newCount);
      const timer = setTimeout(() => setHighlightCount(0), 5000);
      return () => clearTimeout(timer);
    }
    prevCountRef.current = smsList.length;
  }, [smsList.length]);

  const fetchSms = useCallback(async () => {
    await sendCommand(CMD.SMS, { action: 'ls' });
  }, [sendCommand]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="SMS Messages"
        subtitle={`${smsList.length} messages`}
        actions={[
          { label: 'Fetch SMS', icon: MessageSquare, onClick: fetchSms, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={6} />
      ) : smsList.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No SMS messages"
          description="Click Fetch SMS to retrieve messages. New incoming SMS will appear automatically."
          action={{ label: 'Fetch SMS', onClick: fetchSms, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <Card className="shadow-none overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">From/To</TableHead>
                <TableHead className="text-xs">Message</TableHead>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {smsList.map((sms, i) => {
                const isNew = isNewSms(sms.date) || i < highlightCount;
                return (
                  <TableRow
                    key={`sms-${sms.address}-${sms.date}-${i}`}
                    className={isNew ? 'bg-primary/5 animate-in fade-in duration-500' : ''}
                  >
                    <TableCell className="font-mono text-xs">
                      <span className="flex items-center gap-1.5">
                        {sms.address || '-'}
                        {isNew && (
                          <Badge className="text-[9px] px-1 py-0 bg-green-500/90 text-white animate-pulse">
                            New
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs">{sms.body || '-'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{sms.date || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={sms.type === 1 ? 'default' : 'secondary'} className="text-[10px]">
                        {sms.type === 1 ? 'Received' : sms.type === 2 ? 'Sent' : `Type ${sms.type}`}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

