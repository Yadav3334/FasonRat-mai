import { useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, WifiNetwork } from '@/types';
import { CMD, normalizeWifiList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Wifi, WifiOff } from 'lucide-react';

function getSignalStrength(level?: number) {
  if (!level) return 1;
  if (level >= -50) return 4;
  if (level >= -60) return 3;
  if (level >= -70) return 2;
  return 1;
}

function getSignalColor(bars: number) {
  if (bars >= 3) return 'text-success';
  if (bars >= 2) return 'text-warning';
  return 'text-destructive';
}

export default function WifiPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<{
    networks: WifiNetwork[];
    wifiError: string | null;
  }>({
    clientId,
    page: 'wifi',
    extractData: (d) => ({
      networks: normalizeWifiList(extractList(d.list)),
      wifiError: (d.error as string) || null,
    }),
    dataType: 'wifi',
    defaultValue: { networks: [], wifiError: null },
  });

  const networks = rawData.networks;
  const wifiError = rawData.wifiError;

  const scanWifi = useCallback(async () => {
    await sendCommand(CMD.WIFI);
  }, [sendCommand]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="WiFi Networks"
        subtitle={`${networks.length} networks found`}
        actions={[
          { label: 'Scan', icon: Wifi, onClick: scanWifi, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {wifiError && (
        <StatusBadge label={`Scan Error: ${wifiError}`} status="danger" />
      )}

      {loading && !error ? (
        <LoadingSkeleton rows={5} />
      ) : networks.length === 0 ? (
        <EmptyState
          icon={WifiOff}
          title="No WiFi networks found"
          description="Click Scan to detect nearby networks"
          action={{ label: 'Scan WiFi', onClick: scanWifi, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <Card className="shadow-none overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">SSID</TableHead>
                <TableHead className="text-xs hidden sm:table-cell">BSSID</TableHead>
                <TableHead className="text-xs">Signal</TableHead>
                <TableHead className="text-xs">Security</TableHead>
                <TableHead className="text-xs hidden md:table-cell">Frequency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {networks.map((net, i) => {
                const bars = getSignalStrength(net.level);
                return (
                  <TableRow key={`wifi-${net.ssid}-${net.bssid}-${i}`}>
                    <TableCell className="font-medium text-xs">{net.ssid || 'Hidden'}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground hidden sm:table-cell">{net.bssid || '-'}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex items-end gap-0.5">
                          {Array.from({ length: 4 }, (_, j) => (
                            <div
                              key={j}
                              className={`w-1 rounded-sm ${j < bars ? getSignalColor(bars) : 'bg-muted'}`}
                              style={{ height: `${(j + 1) * 3 + 2}px` }}
                            />
                          ))}
                        </div>
                        <span className="text-[10px] text-muted-foreground">{net.level || '-'} dBm</span>
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{net.security || 'Open'}</Badge></TableCell>
                    <TableCell className="text-xs hidden md:table-cell">{net.frequency ? `${net.frequency} MHz` : '-'}</TableCell>
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
