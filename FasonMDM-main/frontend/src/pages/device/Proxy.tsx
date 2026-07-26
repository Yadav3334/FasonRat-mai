import { useState, useCallback, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { DevicePageHeader, ErrorAlert } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Wifi, Play, Square, RefreshCw } from 'lucide-react';
import { onProxyStatus, type ProxyStatusPayload, type ProxyConnectionPayload } from '@/services/socket';
import type { DeviceOutletContext } from '@/types';

export default function ProxyPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [running, setRunning] = useState(false);
  const [port, setPort] = useState(1080);
  const [connections, setConnections] = useState<ProxyConnectionPayload[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Listen for proxy status updates
  useEffect(() => {
    const unsub = onProxyStatus((data: ProxyStatusPayload) => {
      setRunning(data.running);
      if (data.port) setPort(data.port);
    });
    return unsub;
  }, []);

  // Poll proxy status
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/proxy/${clientId}/status`);
      const json = await res.json();
      if (json.success) {
        setRunning(json.running);
        setConnections(json.connections || []);
      }
    } catch (e) {
      // ignore
    }
  }, [clientId]);

  useEffect(() => {
    if (running) {
      const interval = setInterval(refreshStatus, 3000);
      return () => clearInterval(interval);
    }
  }, [running, refreshStatus]);

  const startProxy = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/proxy/${clientId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 1080 }),
      });
      const json = await res.json();
      if (json.success) {
        setRunning(true);
        setPort(json.port || 1080);
      } else {
        setError(json.error || 'Failed to start proxy');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to start proxy');
    } finally {
      setSending(false);
    }
  }, [clientId]);

  const stopProxy = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/proxy/${clientId}/stop`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.success) {
        setRunning(false);
        setConnections([]);
      } else {
        setError(json.error || 'Failed to stop proxy');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to stop proxy');
    } finally {
      setSending(false);
    }
  }, [clientId]);

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (sec: number): string => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  // Get server host for connection info
  const serverHost = window.location.hostname || '127.0.0.1';

  return (
    <div className="space-y-4">
      <DevicePageHeader
        title="SOCKS5 Proxy"
        subtitle={running ? `Listening on ${serverHost}:${port}` : 'Tunnel traffic through device'}
        actions={[
          running
            ? { label: 'Stop Proxy', icon: Square, onClick: stopProxy, disabled: sending }
            : { label: 'Start Proxy', icon: Play, onClick: startProxy, disabled: sending || !online },
          { label: 'Refresh', icon: RefreshCw, onClick: refreshStatus, disabled: sending },
        ]}
        badge={{
          label: running ? 'Running' : 'Stopped',
          variant: running ? 'default' : 'secondary',
          className: 'text-[10px]',
        }}
        loading={sending}
      />

      {error && <ErrorAlert message={error} onRetry={() => setError(null)} />}

      {!running ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Wifi className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">SOCKS5 Proxy Tunneling</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Route your traffic through the device's network. Once started, configure your tools
              (browser, curl, etc.) to use <code className="bg-muted px-1 py-0.5 rounded text-xs">{serverHost}:{port}</code> as a SOCKS5 proxy.
            </p>
            <Button onClick={startProxy} disabled={!online || sending} className="mt-4">
              <Play className="w-4 h-4 mr-2" />
              Start Proxy
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Connection Info */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-sm font-medium">SOCKS5 Proxy Active</span>
                </div>
                <code className="bg-muted px-2 py-1 rounded text-sm font-mono">
                  {serverHost}:{port}
                </code>
                <span className="text-xs text-muted-foreground">
                  Configure your SOCKS5 client with the address above
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Active Connections */}
          <Card className="shadow-none overflow-hidden">
            <div className="px-4 py-2 border-b bg-muted/20">
              <span className="text-sm font-medium">
                Active Connections ({connections.length})
              </span>
            </div>
            {connections.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No active connections. Traffic will appear here when you connect through the proxy.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Connection ID</TableHead>
                    <TableHead className="text-xs">Target</TableHead>
                    <TableHead className="text-xs">Sent</TableHead>
                    <TableHead className="text-xs">Received</TableHead>
                    <TableHead className="text-xs">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((conn) => (
                    <TableRow key={conn.connId}>
                      <TableCell className="font-mono text-xs">{conn.connId.slice(0, 8)}...</TableCell>
                      <TableCell className="font-mono text-xs">{conn.target}</TableCell>
                      <TableCell className="text-xs">{formatBytes(conn.bytesToTarget)}</TableCell>
                      <TableCell className="text-xs">{formatBytes(conn.bytesFromTarget)}</TableCell>
                      <TableCell className="text-xs">{formatDuration(conn.duration)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
