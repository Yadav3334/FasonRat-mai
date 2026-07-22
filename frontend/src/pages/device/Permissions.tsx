import { useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, PermissionEntry } from '@/types';
import { CMD, normalizePermissionList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, GridItemCard, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Button } from '@/components/ui/button';
import { Shield, ShieldCheck, ShieldX, Search } from 'lucide-react';

export default function PermissionsPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();

  const { data: permissions, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<PermissionEntry[]>({
    clientId,
    page: 'permissions',
    extractData: (d) => normalizePermissionList(extractList(d.list)),
    dataType: ['permissions', 'perm_check'],
    defaultValue: [],
  });

  const fetchPermissions = useCallback(async () => {
    await sendCommand(CMD.PERMISSIONS);
  }, [sendCommand]);

  const checkPermission = useCallback(async (permissionName: string) => {
    await sendCommand(CMD.PERM_CHECK, { permission: permissionName });
  }, [sendCommand]);

  const grantedCount = permissions.filter((p) => p.allowed).length;
  const deniedCount = permissions.length - grantedCount;
  const busy = commandStatus === 'sending';

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Permissions"
        subtitle={`${grantedCount} granted, ${deniedCount} denied`}
        actions={[
          { label: 'Fetch', icon: Shield, onClick: fetchPermissions, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={8} variant="cards" />
      ) : permissions.length === 0 ? (
        <EmptyState
          icon={Shield}
          title="No permission data"
          description="Click Fetch to check app permissions"
          action={{ label: 'Fetch Permissions', onClick: fetchPermissions, disabled: loading || !online, loading: busy }}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {permissions.map((perm, i) => (
            <GridItemCard
              key={`perm-${perm.name}-${i}`}
              icon={
                perm.allowed
                  ? <ShieldCheck className="h-4 w-4 text-success" />
                  : <ShieldX className="h-4 w-4 text-destructive" />
              }
              title={perm.name || 'Unknown'}
              badge={
                <div className="flex items-center gap-1">
                  <StatusBadge
                    label={perm.allowed ? 'Granted' : 'Denied'}
                    status={perm.allowed ? 'success' : 'danger'}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => checkPermission(perm.name)}
                    disabled={busy || !online}
                    aria-label={`Check ${perm.name}`}
                  >
                    <Search className="h-3 w-3" />
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
