import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, ClientFile, CameraDevice } from '@/types';
import { CMD, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, SectionCard, LoadingSkeleton, StatusBadge } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera as CameraIcon, Image } from 'lucide-react';
import { sanitizePath } from '@/lib/utils';

export default function CameraPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [capturingId, setCapturingId] = useState<number | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (captureTimerRef.current) {
        clearTimeout(captureTimerRef.current);
        captureTimerRef.current = null;
      }
    };
  }, []);

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<{
    cameras: CameraDevice[];
    photos: ClientFile[];
    permission: boolean | null;
  }>({
    clientId,
    page: 'camera',
    extractData: (d) => ({
      cameras: extractList<CameraDevice>(d.cameras),
      photos: Array.isArray(d.photos) ? d.photos : [],
      permission: d.permission === true || d.permission === false ? d.permission : null,
    }),
    dataType: 'camera',
    defaultValue: { cameras: [], photos: [], permission: null },
  });

  const cameras = rawData.cameras;
  const photos = rawData.photos;
  const permission = rawData.permission;

  const listCameras = useCallback(async () => {
    await sendCommand(CMD.CAMERA, { action: 'list' });
  }, [sendCommand]);

  const capturePhoto = async (cameraId: number) => {
    setCapturingId(cameraId);
    try {
      await sendCommand(CMD.CAMERA, { action: 'capture', id: cameraId });
    } catch {
    }
    captureTimerRef.current = setTimeout(() => setCapturingId(null), 5000);
  };

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Camera"
        subtitle={`${cameras.length} cameras, ${photos.length} photos`}
        actions={[
          { label: 'Detect', icon: CameraIcon, onClick: listCameras, disabled: loading || !online },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {permission !== null && (
        <StatusBadge label={permission ? 'Permission Granted' : 'Permission Denied'} status={permission ? 'success' : 'danger'} />
      )}

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {loading && !error ? (
        <LoadingSkeleton rows={4} />
      ) : (
        <>
          {cameras.length > 0 && (
            <SectionCard title="Available Cameras">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {cameras.map((cam, i) => (
                  <Card key={`cam-${cam.id ?? i}`} className="shadow-none bg-muted/40">
                    <CardContent className="p-3 text-center">
                      <CameraIcon className="h-6 w-6 mx-auto mb-1.5 text-primary" />
                      <p className="font-medium text-xs">{cam.name || `Camera ${i + 1}`}</p>
                      <p className="text-[10px] text-muted-foreground mb-2">ID: {cam.id ?? i}</p>
                      <Button size="sm" onClick={() => capturePhoto(cam.id ?? i)} disabled={capturingId !== null} className="h-7 text-xs">
                        {capturingId === (cam.id ?? i) ? 'Capturing...' : 'Capture'}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </SectionCard>
          )}

          <SectionCard title={`Photos (${photos.length})`} icon={Image}>
            {photos.length === 0 ? (
              <div className="py-6 text-center">
                <Image className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No photos captured</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {photos.map((photo) => (
                  <div key={`photo-${photo.id}`} className="relative group">
                    <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                      <img
                        src={`/api/files/photos/${sanitizePath(clientId)}/${sanitizePath(photo.id)}`}
                        alt={photo.originalName}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{photo.originalName}</p>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
