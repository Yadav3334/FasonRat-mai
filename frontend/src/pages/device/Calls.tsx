import { useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, CallRecord } from '@/types';
import { CMD, normalizeCallList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, LoadingSkeleton } from '@/components/device/shared';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone } from 'lucide-react';

function getCallIcon(type?: number) {
  switch (type) {
    case 1: return <PhoneIncoming className="h-3.5 w-3.5 text-success" />;
    case 2: return <PhoneOutgoing className="h-3.5 w-3.5 text-primary" />;
    case 3: return <PhoneMissed className="h-3.5 w-3.5 text-destructive" />;
    default: return <PhoneIncoming className="h-3.5 w-3.5" />;
  }
}

function getCallType(type?: number) {
  switch (type) {
    case 1: return 'Incoming';
    case 2: return 'Outgoing';
    case 3: return 'Missed';
    default: return type ? `Type ${type}` : '-';
  }
}

function formatDuration(seconds: number): string {
  if (!seconds) return '-';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

export default function CallsPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const { data: callsList, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<CallRecord[]>({
    clientId,
    page: 'calls',
    extractData: (d) => normalizeCallList(extractList(d.list)),
    dataType: 'calls',
    defaultValue: [],
  });

  const fetchCalls = useCallback(async () => {
    await sendCommand(CMD.CALLS);
  }, [sendCommand]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Call Logs"
        subtitle={`${callsList.length} calls`}
        actions={[
          { label: 'Fetch Calls', icon: Phone, onClick: fetchCalls, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={6} />
      ) : callsList.length === 0 ? (
        <EmptyState
          icon={Phone}
          title="No call logs"
          description="Click Fetch Calls to retrieve call history"
          action={{ label: 'Fetch Calls', onClick: fetchCalls, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <Card className="shadow-none overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Type</TableHead>
                <TableHead className="text-xs">Number</TableHead>
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs">Duration</TableHead>
                <TableHead className="text-xs">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {callsList.map((call, i) => (
                <TableRow key={`call-${call.number}-${call.date}-${i}`}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {getCallIcon(call.type)}
                      <Badge
                        variant={call.type === 3 ? 'destructive' : call.type === 1 ? 'default' : 'secondary'}
                        className="text-[10px]"
                      >
                        {getCallType(call.type)}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{call.number || '-'}</TableCell>
                  <TableCell className="text-xs">{call.name || '-'}</TableCell>
                  <TableCell className="text-xs">{formatDuration(call.duration)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{call.date || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
