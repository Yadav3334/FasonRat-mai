import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDevicesStore } from '@/store/devices';
import { useAuthStore } from '@/store/auth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Smartphone, Trash2, RefreshCw, ChevronRight, Search, MapPin, Clock } from 'lucide-react';
import { getCountryFlag, formatDate } from '@/lib/utils';

export default function DevicesPage() {
  const { onlineClients, offlineClients, isLoading, fetchDashboard, deleteDevice } = useDevicesStore();
  const { hasPermission } = useAuthStore();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'online' | 'offline' | 'all'>('all');

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this device?')) return;
    setDeleting(id);
    await deleteDevice(id);
    setDeleting(null);
  };

  const allDevices = [...onlineClients, ...offlineClients];

  const filteredDevices = allDevices.filter((d) => {
    if (search) {
      const q = search.toLowerCase();
      return (
        d.id.toLowerCase().includes(q) ||
        (d.deviceModel || '').toLowerCase().includes(q) ||
        (d.deviceBrand || '').toLowerCase().includes(q) ||
        (d.ip || '').toLowerCase().includes(q) ||
        (d.city || '').toLowerCase().includes(q) ||
        (d.country || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const displayedDevices = filteredDevices.filter((d) => {
    if (tab === 'online') return d.online;
    if (tab === 'offline') return !d.online;
    return true;
  });

  const tabs = [
    { key: 'all' as const, label: 'All', count: allDevices.length },
    { key: 'online' as const, label: 'Online', count: onlineClients.length },
    { key: 'offline' as const, label: 'Offline', count: offlineClients.length },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Smartphone className="h-6 w-6 text-primary" />
            Devices
          </h1>
          <p className="text-muted-foreground mt-1">View and manage all connected devices.</p>
        </div>
        <Button onClick={fetchDashboard} variant="outline" disabled={isLoading} className="self-start">
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex gap-1 p-1 bg-muted rounded-lg">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                tab === t.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
              <span className={`ml-1.5 text-xs ${tab === t.key ? 'text-primary' : 'text-muted-foreground'}`}>
                ({t.count})
              </span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search devices..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-0">
          {displayedDevices.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Smartphone className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">
                {search ? 'No devices match your search' : 'No devices found'}
              </p>
              <p className="text-sm mt-1">
                {search ? 'Try a different search term' : 'Devices will appear here once they connect'}
              </p>
            </div>
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Device</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>IP Address</TableHead>
                      <TableHead>Last Seen</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-[80px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayedDevices.map((client) => (
                      <TableRow
                        key={client.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => navigate(`/device/${client.id}/info`)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                              <Smartphone className="h-5 w-5 text-primary" />
                            </div>
                            <div>
                              <p className="font-medium">{client.deviceModel || 'Unknown'}</p>
                              <p className="text-xs text-muted-foreground">{client.deviceBrand || ''} {client.deviceVersion || ''}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span>{getCountryFlag(client.country)}</span>
                            <span>{client.city || client.country || 'Unknown'}</span>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{client.ip}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDate(client.lastSeen)}</TableCell>
                        <TableCell>
                          {client.online ? (
                            <Badge className="bg-success text-white border-0">Online</Badge>
                          ) : (
                            <Badge variant="secondary">Offline</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); navigate(`/device/${client.id}/info`); }}>
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                            {hasPermission('device:delete') && (
                              <Button variant="ghost" size="icon" onClick={(e) => handleDelete(client.id, e)} disabled={deleting === client.id}>
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="md:hidden divide-y">
                {displayedDevices.map((client) => (
                  <div
                    key={client.id}
                    className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => navigate(`/device/${client.id}/info`)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="h-11 w-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <Smartphone className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">{client.deviceModel || 'Unknown'}</p>
                          {client.online ? (
                            <Badge className="bg-success text-white border-0 text-[10px] px-1.5 py-0">Online</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Offline</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{client.deviceBrand || ''} {client.deviceVersion || ''}</p>
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {getCountryFlag(client.country)} {client.city || client.country || 'Unknown'}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDate(client.lastSeen)}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
