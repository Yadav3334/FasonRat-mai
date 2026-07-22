import { useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, DeviceInfo } from '@/types';
import { CMD } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, SectionCard, LoadingSkeleton } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Smartphone, Battery, HardDrive, Wifi, Monitor, Phone as PhoneIcon } from 'lucide-react';
import { formatDate, formatBytes, safeNum } from '@/lib/utils';

function StatBar({ label, percent, color }: { label: string; percent: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{percent}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
    </div>
  );
}

export default function DeviceInfoPage() {
  const { client, clientId, loadClient, online } = useOutletContext<DeviceOutletContext>();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const { data: deviceInfo, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<DeviceInfo | null>({
    clientId,
    page: 'info',
    extractData: (d) => (d.deviceInfo as DeviceInfo) || null,
    dataType: ['info', 'fason'],
    defaultValue: null,
  });

  const fetchInfo = useCallback(async () => {
    await sendCommand(CMD.INFO);
    timerRef.current = setTimeout(() => { refresh(); loadClient(); }, 3000);
  }, [sendCommand, refresh, loadClient]);

  if (!client) return <div className="text-muted-foreground text-sm">Loading...</div>;

  const batteryLevel = safeNum(deviceInfo?.battery?.level, 0);
  const batteryColor = batteryLevel > 50 ? 'bg-success' : batteryLevel > 20 ? 'bg-warning' : 'bg-destructive';
  const memTotal = safeNum(deviceInfo?.memory?.total, 0);
  const memUsed = safeNum(deviceInfo?.memory?.used, 0);
  const memFree = safeNum(deviceInfo?.memory?.free, 0);
  const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
  const storTotal = safeNum(deviceInfo?.storage?.total, 0);
  const storUsed = safeNum(deviceInfo?.storage?.used, 0);
  const storFree = safeNum(deviceInfo?.storage?.free, 0);
  const storPercent = storTotal > 0 ? Math.round((storUsed / storTotal) * 100) : 0;

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Device Information"
        subtitle="Hardware and system details"
        actions={[
          { label: 'Refresh', icon: Smartphone, onClick: fetchInfo, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="shadow-none">
          <CardContent className="p-3.5 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Smartphone className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-sm truncate">{client.deviceModel || 'Unknown'}</p>
              <p className="text-xs text-muted-foreground">{client.deviceBrand} Android {client.deviceVersion}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="p-3.5 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Wifi className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-sm">{client.ip || 'N/A'}</p>
              <p className="text-xs text-muted-foreground">{client.city || client.country || 'Unknown'}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="p-3.5 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <PhoneIcon className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-sm">Reconnects: {client.reconnectCount}</p>
              <p className="text-xs text-muted-foreground">First seen: {formatDate(client.firstSeen)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {loading && !error && !deviceInfo ? (
        <LoadingSkeleton rows={4} variant="cards" />
      ) : deviceInfo ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {deviceInfo.battery && (
            <SectionCard title="Battery" icon={Battery}>
              <div className="space-y-3">
                <StatBar label="Level" percent={batteryLevel} color={batteryColor} />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Charging</span><span>{deviceInfo.battery.charging ? 'Yes' : 'No'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Health</span><span>{deviceInfo.battery.health || 'N/A'}</span></div>
                </div>
              </div>
            </SectionCard>
          )}

          {deviceInfo.memory && (
            <SectionCard title="Memory (RAM)" icon={HardDrive}>
              <div className="space-y-3">
                <StatBar label="Used" percent={memPercent} color="bg-primary" />
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Total</span><p className="font-medium">{formatBytes(memTotal)}</p></div>
                  <div><span className="text-muted-foreground">Used</span><p className="font-medium">{formatBytes(memUsed)}</p></div>
                  <div><span className="text-muted-foreground">Free</span><p className="font-medium">{formatBytes(memFree)}</p></div>
                </div>
              </div>
            </SectionCard>
          )}

          {deviceInfo.storage && (
            <SectionCard title="Storage" icon={HardDrive}>
              <div className="space-y-3">
                <StatBar label="Used" percent={storPercent} color={storPercent > 90 ? 'bg-destructive' : storPercent > 70 ? 'bg-warning' : 'bg-primary'} />
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Total</span><p className="font-medium">{formatBytes(storTotal)}</p></div>
                  <div><span className="text-muted-foreground">Used</span><p className="font-medium">{formatBytes(storUsed)}</p></div>
                  <div><span className="text-muted-foreground">Free</span><p className="font-medium">{formatBytes(storFree)}</p></div>
                </div>
              </div>
            </SectionCard>
          )}

          {deviceInfo.network && (
            <SectionCard title="Network" icon={Wifi}>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Type</span><p className="font-medium">{deviceInfo.network.type || 'N/A'}</p></div>
                <div><span className="text-muted-foreground">Carrier</span><p className="font-medium">{deviceInfo.network.carrier || 'N/A'}</p></div>
                {deviceInfo.network.subtype && (
                  <div><span className="text-muted-foreground">Subtype</span><p className="font-medium">{deviceInfo.network.subtype}</p></div>
                )}
              </div>
            </SectionCard>
          )}

          {deviceInfo.screen && (
            <SectionCard title="Screen" icon={Monitor}>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Resolution</span><p className="font-medium">{safeNum(deviceInfo.screen.width, 0)} x {safeNum(deviceInfo.screen.height, 0)}</p></div>
                <div><span className="text-muted-foreground">Density</span><p className="font-medium">{safeNum(deviceInfo.screen.density, 0)} dpi</p></div>
              </div>
            </SectionCard>
          )}

          {deviceInfo.phone && (
            <SectionCard title="Phone" icon={PhoneIcon}>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">IMEI</span><p className="font-medium font-mono">{deviceInfo.phone.imei || 'N/A'}</p></div>
                <div><span className="text-muted-foreground">Number</span><p className="font-medium">{deviceInfo.phone.number || 'N/A'}</p></div>
              </div>
            </SectionCard>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Smartphone}
          title="No device info available"
          description="Click Refresh to request device information"
          action={{ label: 'Refresh', onClick: fetchInfo, disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      )}
    </div>
  );
}
