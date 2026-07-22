import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, ClientFile } from '@/types';
import { CMD, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, SectionCard, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Mic as MicIcon, Square, CircleStop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { onDataUpdate } from '@/services/socket';
import { sanitizePath } from '@/lib/utils';

export default function MicPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [recording, setRecording] = useState(false);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [duration, setDuration] = useState('30');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<{
    recordings: ClientFile[];
    status: { status?: string; duration?: number } | null;
  }>({
    clientId,
    page: 'mic',
    extractData: (d) => ({
      recordings: Array.isArray(d.list) ? d.list : [],
      status: (d.status as { status?: string; duration?: number }) || null,
    }),
    dataType: 'mic',
    defaultValue: { recordings: [], status: null },
  });

  const recordings = rawData.recordings;

  useEffect(() => {
    if (rawData.status?.status && !micStatus) {
      setMicStatus(rawData.status.status);
    }
  }, [rawData.status]);

  useEffect(() => {
    const unsub = onDataUpdate((cid, dataType, payload) => {
      if (cid !== clientId) return;
      if (dataType === 'mic_status' && payload) {
        const status = typeof payload.status === 'string' ? payload.status : null;
        setMicStatus(status);
        if (status === 'stopped' || status === 'error') {
          setRecording(false);
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          refresh();
        }
      }
    });
    return unsub;
  }, [clientId, refresh]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const startRecording = async () => {
    const sec = parseInt(duration, 10);
    if (isNaN(sec) || sec < 1) return;
    setRecording(true);
    try {
      await sendCommand(CMD.MIC, { sec });
      timerRef.current = setTimeout(() => {
        refresh();
        setRecording(false);
      }, (sec + 3) * 1000);
    } catch {
      setRecording(false);
    }
  };

  const stopRecording = async () => {
    try {
      await sendCommand(CMD.MIC, { action: 'stop' });
    } catch {
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
  };

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Microphone"
        subtitle={`${recordings.length} recordings`}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      <SectionCard>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              placeholder="Duration (sec)"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="w-28 h-8 text-xs"
              min="1"
              max="3600"
              disabled={recording}
            />
            <span className="text-xs text-muted-foreground">seconds</span>
          </div>
          {!recording ? (
            <Button onClick={startRecording} disabled={!online} size="sm" className="h-8">
              <MicIcon className="h-3.5 w-3.5 mr-1.5" />
              Record
            </Button>
          ) : (
            <Button onClick={stopRecording} variant="destructive" size="sm" className="h-8">
              <CircleStop className="h-3.5 w-3.5 mr-1.5" />
              Stop
            </Button>
          )}
        </div>
        {recording && (
          <div className="mt-2">
            <StatusBadge label="Recording in progress" status="danger" />
          </div>
        )}
        {micStatus && !recording && (
          <div className="mt-2">
            <StatusBadge
              label={micStatus === 'recording' ? 'Recording' : micStatus === 'stopped' ? 'Stopped' : micStatus === 'error' ? 'Error' : micStatus}
              status={micStatus === 'recording' ? 'danger' : micStatus === 'stopped' ? 'success' : micStatus === 'error' ? 'danger' : 'neutral'}
            />
          </div>
        )}
      </SectionCard>

      {loading && !error ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <SectionCard title={`Recordings (${recordings.length})`} icon={MicIcon}>
          {recordings.length === 0 ? (
            <EmptyState
              icon={MicIcon}
              title="No recordings"
              description="Set a duration and click Record to start"
            />
          ) : (
            <div className="space-y-2">
              {recordings.map((rec) => (
                <div key={`rec-${rec.id}`} className="flex items-center gap-3 p-2.5 bg-muted/40 rounded-lg">
                  <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <MicIcon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{rec.originalName}</p>
                    <p className="text-[10px] text-muted-foreground">{rec.createdAt ? new Date(rec.createdAt).toLocaleString() : '—'}</p>
                  </div>
                  <audio controls className="h-7 w-32 sm:w-40">
                    <source src={`/api/files/recordings/${sanitizePath(clientId)}/${sanitizePath(rec.id)}`} type="audio/mp4" />
                  </audio>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
