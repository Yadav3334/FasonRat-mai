import { useState, useCallback, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, GpsLocation } from '@/types';
import { CMD, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, SectionCard, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MapPin, Play, Square, ExternalLink, Navigation, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { clientsApi } from '@/services/api';

function AddressDisplay({ lat, lon }: { lat: number; lon: number }) {
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (!lat || !lon) return;
    
    setLoading(true);
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`)
      .then(res => res.json())
      .then(data => {
        if (mounted && data.display_name) {
          setAddress(data.display_name);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, [lat, lon]);

  if (loading) {
    return <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1"><Loader2 className="h-3 w-3 animate-spin" /> Fetching address...</div>;
  }
  if (!address) return null;

  return (
    <div className="text-sm text-muted-foreground mt-1 leading-snug">
      {address}
    </div>
  );
}

export default function GpsPage() {
  const { client, clientId, online } = useOutletContext<DeviceOutletContext>();
  const [gpsInterval, setGpsInterval] = useState(client?.gpsInterval ?? 0);
  const [customInterval, setCustomInterval] = useState('30');

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<{
    locations: GpsLocation[];
    interval: number;
    deviceError: string | null;
  }>({
    clientId,
    page: 'gps',
    extractData: (d) => ({
      locations: extractList<GpsLocation>(d.list).map((loc) => {
        // Normalize time: could be ISO string, epoch millis number, or numeric string
        let timeStr = '';
        const rawTime = (loc as Record<string, unknown>).time ?? (loc as Record<string, unknown>).timestamp;
        if (rawTime) {
          if (typeof rawTime === 'number') {
            // epoch millis from old data
            timeStr = new Date(rawTime).toLocaleString();
          } else if (typeof rawTime === 'string') {
            // Could be ISO string or numeric string (epoch ms stored as string)
            const asNum = Number(rawTime);
            if (!isNaN(asNum) && rawTime.length > 8) {
              timeStr = new Date(asNum).toLocaleString();
            } else {
              const parsed = new Date(rawTime);
              timeStr = isNaN(parsed.getTime()) ? rawTime : parsed.toLocaleString();
            }
          }
        }
        return {
          latitude: typeof loc.latitude === 'number' ? loc.latitude : 0,
          longitude: typeof loc.longitude === 'number' ? loc.longitude : 0,
          accuracy: typeof loc.accuracy === 'number' ? loc.accuracy : undefined,
          speed: typeof loc.speed === 'number' ? loc.speed : undefined,
          provider: typeof loc.provider === 'string' ? loc.provider : undefined,
          time: timeStr,
        };
      }),
      interval: typeof d.interval === 'number' ? d.interval : 0,
      deviceError: typeof d.error === 'string' ? d.error : null,
    }),
    dataType: 'gps',
    defaultValue: { locations: [], interval: 0, deviceError: null },
  });

  const locations = rawData.locations;
  const serverInterval = rawData.interval;
  const deviceError = rawData.deviceError;
  const displayError = error || deviceError;

  useEffect(() => {
    if (serverInterval !== gpsInterval) {
      setGpsInterval(serverInterval);
    }
  }, [serverInterval]);

  const fetchGps = useCallback(async () => {
    await sendCommand(CMD.LOCATION);
  }, [sendCommand]);

  const startPolling = async () => {
    const val = parseInt(customInterval, 10);
    if (isNaN(val) || val < 1) return;
    try {
      await clientsApi.setGps(clientId, val);
      setGpsInterval(val);
    } catch {
    }
  };

  const stopPolling = async () => {
    try {
      await clientsApi.setGps(clientId, 0);
      setGpsInterval(0);
    } catch {
    }
  };

  const latest = locations.length > 0 ? locations[locations.length - 1] : null;

  const PAGE_SIZE = 20;
  const [historyPage, setHistoryPage] = useState(1);
  const totalHistoryPages = Math.max(1, Math.ceil(locations.length / PAGE_SIZE));
  const paginatedLocations = locations.slice((historyPage - 1) * PAGE_SIZE, historyPage * PAGE_SIZE);

  useEffect(() => {
    setHistoryPage(1);
  }, [locations.length]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="GPS Location"
        subtitle={`${locations.length} recorded locations`}
        actions={[
          { label: 'Fetch Location', icon: MapPin, onClick: fetchGps, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {displayError && <ErrorAlert message={displayError} onRetry={refresh} />}

      <SectionCard>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              placeholder="Interval (sec)"
              value={customInterval}
              onChange={(e) => setCustomInterval(e.target.value)}
              className="w-24 h-8 text-xs"
              min="1"
              max="3600"
            />
            <span className="text-xs text-muted-foreground">sec</span>
            <Button onClick={startPolling} disabled={gpsInterval > 0 || !online} size="sm" className="h-8">
              <Play className="h-3 w-3 mr-1" /> Start
            </Button>
            <Button onClick={stopPolling} variant="destructive" disabled={gpsInterval === 0 || !online} size="sm" className="h-8">
              <Square className="h-3 w-3 mr-1" /> Stop
            </Button>
          </div>
          {gpsInterval > 0 && (
            <StatusBadge label={`Polling every ${gpsInterval}s`} status="success" />
          )}
        </div>
      </SectionCard>

      {loading && !displayError ? (
        <LoadingSkeleton rows={4} />
      ) : (
        <>
          {latest && (
            <Card className="shadow-sm overflow-hidden border mb-5">
              <div className="border-b bg-muted/40 px-4 py-3 flex items-center gap-2">
                <MapPin className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Last Known Location</h3>
              </div>
              <div className="w-full">
                <iframe
                  width="100%"
                  height="350"
                  frameBorder="0"
                  style={{ border: 0, display: 'block' }}
                  src={`https://maps.google.com/maps?q=${latest.latitude},${latest.longitude}&hl=en&z=15&output=embed`}
                  allowFullScreen
                  title="Device Location"
                />
              </div>
              <div className="bg-card p-4 border-t">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-bold font-mono text-foreground">
                      {latest.latitude}, {latest.longitude}
                    </p>
                    <AddressDisplay lat={latest.latitude} lon={latest.longitude} />
                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Navigation className="h-3 w-3" /> 
                        Accuracy: {latest.accuracy ? `${latest.accuracy}m` : 'N/A'}
                      </span>
                      {latest.speed != null && <span>Speed: {latest.speed} m/s</span>}
                      <span>
                        Provider: 
                        <Badge variant="outline" className="text-[10px] ml-1 font-normal uppercase">{latest.provider || 'N/A'}</Badge>
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col sm:items-end gap-1.5">
                    {latest.time && <span className="text-xs text-muted-foreground">{latest.time}</span>}
                    <a
                      href={`https://www.google.com/maps?q=${latest.latitude},${latest.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 hover:underline transition-colors"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open in Google Maps
                    </a>
                  </div>
                </div>
              </div>
            </Card>
          )}

          <SectionCard title={`Location History (${locations.length})`} icon={MapPin}>
            {locations.length === 0 ? (
              <div className="py-6 text-center">
                <MapPin className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No GPS data available</p>
                <p className="text-xs text-muted-foreground/50 mt-1">Click Fetch Location to get current position</p>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Latitude</TableHead>
                      <TableHead className="text-xs">Longitude</TableHead>
                      <TableHead className="text-xs">Accuracy</TableHead>
                      <TableHead className="text-xs hidden sm:table-cell">Speed</TableHead>
                      <TableHead className="text-xs hidden md:table-cell">Provider</TableHead>
                      <TableHead className="text-xs">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedLocations.map((loc, i) => (
                      <TableRow key={`gps-${loc.latitude}-${loc.longitude}-${loc.time || i}`}>
                        <TableCell className="font-mono text-xs">{loc.latitude}</TableCell>
                        <TableCell className="font-mono text-xs">{loc.longitude}</TableCell>
                        <TableCell className="text-xs">{loc.accuracy ? `${loc.accuracy}m` : '-'}</TableCell>
                        <TableCell className="text-xs hidden sm:table-cell">{loc.speed != null ? `${loc.speed} m/s` : '-'}</TableCell>
                        <TableCell className="hidden md:table-cell"><Badge variant="outline" className="text-[10px]">{loc.provider || '-'}</Badge></TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{loc.time || '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {totalHistoryPages > 1 && (
                  <div className="flex items-center justify-between mt-3 pt-3 border-t">
                    <span className="text-xs text-muted-foreground">
                      Page {historyPage} of {totalHistoryPages} ({locations.length} total)
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setHistoryPage(p => Math.max(1, p - 1))}
                        disabled={historyPage <= 1}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setHistoryPage(p => Math.min(totalHistoryPages, p + 1))}
                        disabled={historyPage >= totalHistoryPages}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
