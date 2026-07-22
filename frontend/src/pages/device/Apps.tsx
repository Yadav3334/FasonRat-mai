import { useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, AppEntry } from '@/types';
import { CMD, normalizeAppList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, GridItemCard, LoadingSkeleton } from '@/components/device/shared';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Smartphone, Search } from 'lucide-react';

export default function AppsPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [showSystem, setShowSystem] = useState(false);
  const [search, setSearch] = useState('');

  const { data: apps, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<AppEntry[]>({
    clientId,
    page: 'apps',
    extractData: (d) => normalizeAppList(extractList(d.list)),
    dataType: 'apps',
    defaultValue: [],
  });

  const fetchUserApps = useCallback(async () => {
    await sendCommand(CMD.APPS, { sys: false });
  }, [sendCommand]);

  const fetchAllApps = useCallback(async () => {
    await sendCommand(CMD.APPS, { sys: true });
  }, [sendCommand]);

  const filteredApps = useMemo(() => {
    const base = showSystem ? apps : apps.filter((a) => !a.isSystem);
    if (!search) return base;
    const q = search.toLowerCase();
    return base.filter(
      (a) => a.name.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q)
    );
  }, [apps, showSystem, search]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Installed Apps"
        subtitle={`${filteredApps.length} apps`}
        actions={[
          { label: 'User', icon: Smartphone, onClick: fetchUserApps, disabled: loading || !online },
          { label: 'All', onClick: fetchAllApps, disabled: loading || !online, variant: 'outline' },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      <div className="flex items-center gap-2">
        <div className="relative flex-1 sm:flex-initial">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs w-full sm:w-56"
          />
        </div>
        <Badge
          variant={showSystem ? 'secondary' : 'outline'}
          className="cursor-pointer select-none text-xs px-2.5 py-1"
          onClick={() => setShowSystem(!showSystem)}
        >
          {showSystem ? 'All Apps' : 'User Only'}
        </Badge>
      </div>

      {loading && !error ? (
        <LoadingSkeleton rows={9} variant="cards" />
      ) : filteredApps.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title={search ? 'No apps match your search' : 'No apps data'}
          description={search ? 'Try a different search' : 'Click User or All to fetch app list'}
          action={!search ? { label: 'Fetch Apps', onClick: fetchUserApps, disabled: loading || !online, loading: commandStatus === 'sending' } : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {filteredApps.map((app, i) => (
            <GridItemCard
              key={`app-${app.packageName}-${i}`}
              icon={<Smartphone className="h-4 w-4 text-primary" />}
              title={app.name || 'Unknown'}
              subtitle={app.packageName}
              badge={
                app.isSystem ? (
                  <Badge variant="outline" className="text-[10px] shrink-0">System</Badge>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
