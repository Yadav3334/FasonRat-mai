import { useState, useCallback, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, GpsLocation } from '@/types';
import { CMD, extractList } from '@/types';
import { DevicePageHeader, ErrorAlert, SectionCard, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  MapPin, Play, Square, ExternalLink, Navigation, ChevronLeft, ChevronRight, Loader2,
} from 'lucide-react';
import { clientsApi } from '@/services/api';
import { onGpsLocation, type GpsLocationPayload } from '@/services/socket';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icon
const markerIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
});

type GpsDiagnostics = Record<string, string | number | boolean | null>;

function AddressDisplay({ lat, lon }: { lat: number; lon: number }) {
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRequestRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    if (!lat || !lon) return;

    const now = Date.now();
    const delay = Math.max(0, 1000 - (now - lastRequestRef.current));
    lastRequestRef.current = now + delay;

    const timer = setTimeout(() => {
      if (!mounted) return;
      setLoading(true);
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`)
        .then(res => res.json())
        .then(data => { if (mounted && data.display_name) setAddress(data.display_name); })
        .catch(() => {})
        .finally(() => { if (mounted) setLoading(false); });
    }, delay);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [lat, lon]);
  if (loading) return <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1"><Loader2 className="h-3 w-3 animate-spin" /> Fetching...</div>;
  if (!address) return null;
  return <div className="text-sm text-muted-foreground mt-1 leading-snug">{address}</div>;
}

function MapBoundsUpdater({ positions }: { positions: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length > 0) {
      const bounds = L.latLngBounds(positions);
      if (positions.length === 1) map.setView(positions[0], 16);
      else map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    }
  }, [positions, map]);
  return null;
}

export default function GpsPage() {
  const { client, clientId, online } = useOutletContext<DeviceOutletContext>();
  const [gpsInterval, setGpsInterval] = useState(client?.gpsInterval ?? 0);
  const [customInterval, setCustomInterval] = useState('30');
  const [livePositions, setLivePositions] = useState<Array<[number, number]>>([]);
  const [liveLabel, setLiveLabel] = useState('');

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<{
    locations: GpsLocation[]; interval: number; deviceError: string | null; diagnostics: GpsDiagnostics | null;
  }>({
    clientId, page: 'gps',
    extractData: (d) => ({
      locations: extractList<GpsLocation>(d.list).map((loc) => {
        let timeStr = '';
        const rawLoc = loc as unknown as Record<string, unknown>;
        const rawTime = rawLoc.time ?? rawLoc.timestamp;
        if (rawTime) {
          if (typeof rawTime === 'number') timeStr = new Date(rawTime).toLocaleString();
          else if (typeof rawTime === 'string') {
            const parsed = new Date(rawTime);
            timeStr = isNaN(parsed.getTime()) ? rawTime : parsed.toLocaleString();
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
      diagnostics: d.diagnostics && typeof d.diagnostics === 'object' && !Array.isArray(d.diagnostics)
        ? d.diagnostics as GpsDiagnostics
        : null,
    }),
    dataType: 'gps', defaultValue: { locations: [], interval: 0, deviceError: null, diagnostics: null },
    socketDebounceMs: 1000,
  });

  const locations = rawData.locations;
  const serverInterval = rawData.interval;
  const deviceError = rawData.deviceError;
  const diagnostics = rawData.diagnostics;
  const displayError = error || deviceError;

  useEffect(() => {
    if (serverInterval !== gpsInterval) setGpsInterval(serverInterval);
  }, [serverInterval]);

  // Initialize live positions from historical data
  useEffect(() => {
    if (locations.length > 0) {
      setLivePositions(locations.filter(l => l.latitude && l.longitude).map(l => [l.latitude, l.longitude] as [number, number]));
    }
  }, [locations.length]);

  // Live GPS via WebSocket
  useEffect(() => {
    const unsub = onGpsLocation((payload: GpsLocationPayload) => {
      if (payload.id !== clientId) return;
      setLivePositions(prev => {
        const next: Array<[number, number]> = [...prev, [payload.latitude, payload.longitude]];
        return next.length > 1000 ? next.slice(next.length - 1000) : next;
      });
      setLiveLabel(`${payload.latitude.toFixed(5)}, ${payload.longitude.toFixed(5)} · ${payload.accuracy ?? '?'}m`);
    });
    return unsub;
  }, [clientId]);

  const fetchTimerRef1 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchTimerRef2 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchGps = useCallback(async () => {
    await sendCommand(CMD.LOCATION, { action: 'fetch' });
    if (fetchTimerRef1.current) clearTimeout(fetchTimerRef1.current);
    fetchTimerRef1.current = setTimeout(refresh, 3000);
    if (fetchTimerRef2.current) clearTimeout(fetchTimerRef2.current);
    fetchTimerRef2.current = setTimeout(refresh, 8000);
  }, [sendCommand, refresh]);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (fetchTimerRef1.current) clearTimeout(fetchTimerRef1.current);
    if (fetchTimerRef2.current) clearTimeout(fetchTimerRef2.current);
  }, []);

  const startPolling = async () => {
    const val = parseInt(customInterval, 10);
    if (isNaN(val) || val < 1) return;
    try { await clientsApi.setGps(clientId, val); setGpsInterval(val); } catch {}
  };
  const stopPolling = async () => {
    try { await clientsApi.setGps(clientId, 0); setGpsInterval(0); } catch {}
  };

  const latest = locations.length > 0 ? locations[locations.length - 1] : null;
  const PAGE_SIZE = 20;
  const [historyPage, setHistoryPage] = useState(1);
  const totalHistoryPages = Math.max(1, Math.ceil(locations.length / PAGE_SIZE));
  const paginatedLocations = locations.slice((historyPage - 1) * PAGE_SIZE, historyPage * PAGE_SIZE);
  useEffect(() => { setHistoryPage(1); }, [locations.length]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="GPS Location"
        subtitle={`${locations.length} recorded locations`}
        actions={[{ label: 'Fetch Location', icon: MapPin, onClick: fetchGps, disabled: loading || !online }]}
        refresh={refresh} loading={loading} commandStatus={commandStatus}
      />
      {displayError && <ErrorAlert message={displayError} onRetry={refresh} />}
      {displayError && diagnostics && (
        <SectionCard title="GPS Diagnostics" icon={MapPin}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(diagnostics).map(([key, value]) => (
              <div key={key} className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{key}</p>
                <p className="mt-1 font-mono text-xs">
                  {typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value ?? '-')}
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex items-center gap-2">
            <Input type="number" placeholder="Interval (sec)" value={customInterval}
              onChange={(e) => setCustomInterval(e.target.value)} className="w-24 h-8 text-xs" min="1" max="3600" />
            <span className="text-xs text-muted-foreground">sec</span>
            <Button onClick={startPolling} disabled={gpsInterval > 0 || !online} size="sm" className="h-8">
              <Play className="h-3 w-3 mr-1" /> Start
            </Button>
            <Button onClick={stopPolling} variant="destructive" disabled={gpsInterval === 0 || !online} size="sm" className="h-8">
              <Square className="h-3 w-3 mr-1" /> Stop
            </Button>
          </div>
          {gpsInterval > 0 && <StatusBadge label={`Polling every ${gpsInterval}s`} status="success" />}
          {liveLabel && <StatusBadge label={liveLabel} status="neutral" />}
        </div>
      </SectionCard>

      {loading && !displayError ? <LoadingSkeleton rows={4} /> : (
        <>
          <Card className="shadow-sm overflow-hidden border">
            <div className="border-b bg-muted/40 px-4 py-3 flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Live Map</h3>
            </div>
            <div className="w-full h-[400px]">
              <MapContainer center={[21.02, 105.85]} zoom={3} style={{ height: '100%', width: '100%' }}>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapBoundsUpdater positions={livePositions} />
                {livePositions.length > 0 && (
                  <Marker position={livePositions[livePositions.length - 1]} icon={markerIcon}>
                    <Popup>
                      <b>{new Date().toLocaleTimeString()}</b><br/>
                      {livePositions[livePositions.length - 1][0].toFixed(5)}, {livePositions[livePositions.length - 1][1].toFixed(5)}
                    </Popup>
                  </Marker>
                )}
                {livePositions.length > 1 && (
                  <Polyline positions={livePositions} color="#FF9800" weight={3} opacity={0.7} />
                )}
              </MapContainer>
            </div>
          </Card>

          <SectionCard title={`Location History (${locations.length})`} icon={MapPin}>
            {locations.length === 0 ? (
              <div className="py-6 text-center">
                <MapPin className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No GPS data available</p>
                <p className="text-xs text-muted-foreground/50 mt-1">Click Fetch Location to get current position</p>
              </div>
            ) : (
              <>
                <Table><TableHeader><TableRow>
                  <TableHead className="text-xs">Latitude</TableHead><TableHead className="text-xs">Longitude</TableHead>
                  <TableHead className="text-xs">Accuracy</TableHead><TableHead className="text-xs hidden sm:table-cell">Speed</TableHead>
                  <TableHead className="text-xs hidden md:table-cell">Provider</TableHead><TableHead className="text-xs">Time</TableHead>
                </TableRow></TableHeader>
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
                </TableBody></Table>
                {totalHistoryPages > 1 && (
                  <div className="flex items-center justify-between mt-3 pt-3 border-t">
                    <span className="text-xs text-muted-foreground">Page {historyPage} of {totalHistoryPages} ({locations.length} total)</span>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setHistoryPage(p => Math.max(1, p - 1))} disabled={historyPage <= 1}><ChevronLeft className="h-3.5 w-3.5" /></Button>
                      <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setHistoryPage(p => Math.min(totalHistoryPages, p + 1))} disabled={historyPage >= totalHistoryPages}><ChevronRight className="h-3.5 w-3.5" /></Button>
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
