import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { clientsApi } from '@/services/api';
import type { ClientDevice, DeviceOutletContext } from '@/types';
import { useAuthStore } from '@/store/auth';
import { getDeviceTabs } from '@/config/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Smartphone, RefreshCw, Trash2, AlertCircle, KeyRound, ShieldX, Loader2 } from 'lucide-react';
import { cn, getCountryFlag } from '@/lib/utils';

export default function DevicePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuthStore();
  const deviceTabs = getDeviceTabs(hasPermission);
  const [client, setClient] = useState<ClientDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [credentialAction, setCredentialAction] = useState<'rotate' | 'revoke' | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  const loadClient = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await clientsApi.getOne(id);
      if (res.data.success) {
        setClient(res.data.data);
      } else {
        setError('Device not found');
      }
    } catch {
      setError('Failed to load device. It may not exist or the server is unreachable.');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial route data load
    loadClient();
  }, [loadClient]);

  // Removed empty useEffect that did nothing

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = async () => {
    if (!id) return;
    try {
      const res = await clientsApi.delete(id);
      if (res.data.success) {
        navigate('/devices');
      }
    } catch {
      // Stay on page on error — could add toast notification
    }
    setShowDeleteConfirm(false);
  };

  const getApiError = (err: unknown, fallback: string) => {
    const responseError = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
    return responseError || fallback;
  };

  const handleRotateCredential = async () => {
    if (!id || !window.confirm('Rotate this device credential now? The device must remain online while the new credential is delivered.')) return;
    setCredentialAction('rotate');
    setCredentialError(null);
    try {
      await clientsApi.rotateCredential(id);
      await loadClient();
    } catch (err: unknown) {
      setCredentialError(getApiError(err, 'Failed to rotate device credential.'));
    } finally {
      setCredentialAction(null);
    }
  };

  const handleRevokeCredential = async () => {
    if (!id || !window.confirm('Revoke this device credential? The device will be disconnected and cannot reconnect with its current APK.')) return;
    setCredentialAction('revoke');
    setCredentialError(null);
    try {
      await clientsApi.revokeCredential(id);
      await loadClient();
    } catch (err: unknown) {
      setCredentialError(getApiError(err, 'Failed to revoke device credential.'));
    } finally {
      setCredentialAction(null);
    }
  };

  if (loading && !client) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error && !client) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center space-y-4 max-w-md">
          <AlertCircle className="h-12 w-12 mx-auto text-destructive" />
          <h3 className="text-lg font-semibold">Device Not Found</h3>
          <p className="text-sm text-muted-foreground">{error}</p>
          <div className="flex gap-2 justify-center">
            <Button onClick={loadClient} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" /> Retry
            </Button>
            <Button onClick={() => navigate('/devices')} variant="outline">
              ← Back
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 -m-4 md:-m-6 lg:-m-8">
      <div className="bg-card border-b">
        <div className="px-4 md:px-6 py-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/devices')} className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground -ml-2">
              ←
            </Button>
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Smartphone className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold truncate">{client?.deviceModel || 'Unknown Device'}</h2>
                {client?.online ? (
                  <Badge className="bg-success/15 text-success border-success/25 text-[10px] px-1.5 py-0">Online</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Offline</Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                <span className="font-mono truncate max-w-[100px]" title={id}>{id?.substring(0, 10)}...</span>
                <span>·</span>
                <span>{getCountryFlag(client?.country ?? null)} {client?.city || client?.country || client?.ip || 'Unknown'}</span>
                {client?.online && (
                  <>
                    <span className="hidden sm:inline">·</span>
                    <span className="hidden sm:inline">{client.ip}</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {hasPermission('device:command') && client?.online && (
                <Button variant="ghost" size="icon" onClick={handleRotateCredential} disabled={credentialAction !== null} className="h-8 w-8" aria-label="Rotate device credential" title="Rotate device credential">
                  {credentialAction === 'rotate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                </Button>
              )}
              {hasPermission('device:delete') && (
                <Button variant="ghost" size="icon" onClick={handleRevokeCredential} disabled={credentialAction !== null} className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label="Revoke device credential" title="Revoke device credential">
                  {credentialAction === 'revoke' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldX className="h-3.5 w-3.5" />}
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={loadClient} disabled={loading} className="h-8 w-8" aria-label="Refresh device">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </Button>
              {hasPermission('device:delete') && !showDeleteConfirm && (
                <Button variant="ghost" size="icon" onClick={() => setShowDeleteConfirm(true)} className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label="Delete device">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
              {showDeleteConfirm && (
                <div className="flex items-center gap-1">
                  <Button variant="destructive" size="sm" onClick={handleDelete} className="h-7 text-xs px-2">
                    Confirm
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)} className="h-7 text-xs px-2">
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t">
          <div className="hidden md:block">
            <div className="flex items-center overflow-x-auto px-2 gap-0.5 scrollbar-none">
              {deviceTabs.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={`/device/${id}/${tab.to}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap border-b-2',
                      isActive
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
                    )
                  }
                >
                  <tab.icon className="h-3.5 w-3.5 shrink-0" />
                  {tab.label}
                </NavLink>
              ))}
            </div>
          </div>

          <div className="md:hidden">
            <div className="flex items-center overflow-x-auto px-3 py-1.5 gap-1 scrollbar-none">
              {deviceTabs.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={`/device/${id}/${tab.to}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    )
                  }
                >
                  <tab.icon className="h-3 w-3 shrink-0" />
                  {tab.label}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      </div>

      {credentialError && (
        <div className="mx-4 md:mx-6 lg:mx-8 mt-2 p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{credentialError}</span>
        </div>
      )}

      {!client?.online && (
        <div className="mx-4 md:mx-6 lg:mx-8 mt-2 p-2.5 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">Device Offline</span>
          <span className="text-warning/70">— Some features may be unavailable until the device reconnects.</span>
        </div>
      )}
      <div className="p-4 md:p-6 lg:p-8 pt-2 md:pt-4 lg:pt-6">
        <Outlet context={{ client, clientId: id ?? '', loadClient, online: !!client?.online } satisfies DeviceOutletContext} />
      </div>
    </div>
  );
}
