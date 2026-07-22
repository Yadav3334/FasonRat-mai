import { useState, useEffect, useRef } from 'react';
import { builderApi } from '@/services/api';
import { onBuilderProgress, type BuilderProgress } from '@/services/socket';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Wrench, Download, CheckCircle2, XCircle, Loader2, AlertCircle, X,
  Upload, Server, Package, Info, StopCircle, ShieldCheck,
} from 'lucide-react';

const BUILD_STEPS = ['checking', 'decompiling', 'patching', 'building', 'signing'] as const;
type BuildStep = typeof BUILD_STEPS[number];

const STEP_LABELS: Record<BuildStep, string> = {
  checking: 'Checking Prerequisites',
  decompiling: 'Decompiling APK',
  patching: 'Patching Configuration',
  building: 'Rebuilding APK',
  signing: 'Signing APK',
};

const MAX_APP_NAME_LENGTH = 50;

export default function BuilderPage() {
  const getDefaultServerUrl = () => {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port;
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      if (port) return `${protocol}//${host}:${port}`;
      return `${protocol}//${host}`;
    }
    return 'http://127.0.0.1:32766';
  };

  const [serverUrl, setServerUrl] = useState(getDefaultServerUrl);
  const [homePageUrl, setHomePageUrl] = useState('https://google.com');
  const [appName, setAppName] = useState('Fason');
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<BuilderProgress | null>(null);
  const [buildComplete, setBuildComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const iconPreviewUrlRef = useRef<string | null>(null);
  const dragCounterRef = useRef(0);

  // Listen for builder progress via Socket.IO
  useEffect(() => {
    const unsubscribe = onBuilderProgress((data: BuilderProgress) => {
      setProgress(data);
      if (data.complete) {
        setBuilding(false);
        setCancelling(false);
        if (!data.error) setBuildComplete(true);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return () => {
      if (iconPreviewUrlRef.current) URL.revokeObjectURL(iconPreviewUrlRef.current);
    };
  }, []);

  const processIconFile = (file: File | null) => {
    if (iconPreviewUrlRef.current) {
      URL.revokeObjectURL(iconPreviewUrlRef.current);
      iconPreviewUrlRef.current = null;
    }
    setIconFile(file);
    if (file) {
      if (!file.type.startsWith('image/')) {
        setError('Please select a valid image file (PNG, JPEG, or WebP)');
        return;
      }
      const url = URL.createObjectURL(file);
      iconPreviewUrlRef.current = url;
      setIconPreview(url);
    } else {
      setIconPreview(null);
    }
  };

  const removeIcon = () => {
    if (iconPreviewUrlRef.current) {
      URL.revokeObjectURL(iconPreviewUrlRef.current);
      iconPreviewUrlRef.current = null;
    }
    setIconFile(null);
    setIconPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounterRef.current++;
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;
    const file = e.dataTransfer.files?.[0] || null;
    if (file) processIconFile(file);
  };

  const startBuild = async () => {
    setError(null);
    if (!serverUrl.trim()) { setError('Server URL is required'); return; }
    if (!serverUrl.match(/^https?:\/\/.+/)) { setError('Server URL must start with http:// or https://'); return; }
    if (!homePageUrl.trim()) { setError('Home Page URL is required'); return; }
    if (!homePageUrl.match(/^https?:\/\/.+/)) { setError('Home Page URL must start with http:// or https://'); return; }
    if (!appName.trim()) { setError('App name is required'); return; }
    if (appName.trim().length > MAX_APP_NAME_LENGTH) { setError(`App name must be ${MAX_APP_NAME_LENGTH} characters or less`); return; }

    setBuilding(true);
    setProgress(null);
    setBuildComplete(false);
    setCancelling(false);

    const formData = new FormData();
    formData.append('serverUrl', serverUrl.trim());
    formData.append('homePageUrl', homePageUrl.trim());
    formData.append('appName', appName.trim());
    if (iconFile) formData.append('appIcon', iconFile);

    try {
      const res = await builderApi.build(formData);
      if (!res.data.success) {
        setError(res.data.error || 'Build failed to start');
        setBuilding(false);
      }
      // Progress will come via Socket.IO — no need to connect SSE
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start build');
      setBuilding(false);
    }
  };

  const cancelBuild = async () => {
    setCancelling(true);
    try {
      await builderApi.cancelBuild();
    } catch {
      setError('Failed to cancel build');
      setCancelling(false);
    }
  };

  const downloadApk = async () => {
    setDownloading(true);
    setDownloadProgress(0);
    try {
      const res = await builderApi.downloadApk((e) => {
        if (e.total) setDownloadProgress(Math.round((e.loaded * 100) / e.total));
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${appName || 'Fason'}.apk`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setError('Failed to download APK. It may not be ready yet.');
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
    }
  };

  const getStepStatus = (step: BuildStep): 'pending' | 'active' | 'done' | 'failed' => {
    if (!progress) return 'pending';
    const currentIdx = BUILD_STEPS.indexOf(progress.step as BuildStep);
    const stepIdx = BUILD_STEPS.indexOf(step);
    if (progress.complete && progress.error && progress.step === step) return 'failed';
    if (progress.complete && !progress.error && progress.step === step) return 'done';
    if (!progress.complete && progress.step === step) return 'active';
    if (currentIdx > stepIdx) return 'done';
    return 'pending';
  };

  const getOverallPercent = (): number => {
    if (!progress) return 0;
    if (progress.complete) return 100;
    const idx = BUILD_STEPS.indexOf(progress.step as BuildStep);
    if (idx < 0) return 0;
    return Math.round(((idx + 0.5) / BUILD_STEPS.length) * 100);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Wrench className="h-5 w-5 text-primary" />
          </div>
          APK Builder
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Build a custom APK with your server configuration. Requires Java Runtime on the server.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive flex items-start gap-3">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-sm">Error</p>
            <p className="text-sm mt-0.5 opacity-90">{error}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setError(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" /> Configuration
          </CardTitle>
          <CardDescription>Configure the APK with your server details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="serverUrl">Server URL</Label>
            <Input
              id="serverUrl"
              value={serverUrl}
              onChange={(e) => { setServerUrl(e.target.value); setError(null); }}
              placeholder="http://your-server:32766"
              disabled={building}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">The URL where your Fason server is running</p>
          </div>

          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-start gap-3">
            <ShieldCheck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Automatic secure enrollment</p>
              <p className="text-xs text-muted-foreground">
                The backend generates a unique one-time bootstrap token for this APK. It can enroll one device, which then receives its own encrypted credential. Build another APK to enroll another device.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="homePageUrl">Home Page URL</Label>
            <Input
              id="homePageUrl"
              value={homePageUrl}
              onChange={(e) => { setHomePageUrl(e.target.value); setError(null); }}
              placeholder="https://google.com"
              disabled={building}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">The web page shown when the app opens</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="appName">App Name</Label>
            <Input
              id="appName"
              value={appName}
              onChange={(e) => { setAppName(e.target.value); setError(null); }}
              placeholder="Fason"
              disabled={building}
              maxLength={MAX_APP_NAME_LENGTH}
            />
            <p className="text-xs text-muted-foreground">
              The display name of the app on the device
              <span className="ml-1 opacity-60">({appName.length}/{MAX_APP_NAME_LENGTH})</span>
            </p>
          </div>

          <div className="space-y-2">
            <Label>App Icon <span className="text-muted-foreground font-normal">(optional)</span></Label>

            {iconPreview ? (
              <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/50">
                <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden border shrink-0">
                  <img src={iconPreview} alt="Preview" className="h-full w-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{iconFile?.name}</p>
                  <p className="text-xs text-muted-foreground">{iconFile ? `${(iconFile.size / 1024).toFixed(1)} KB` : ''}</p>
                </div>
                <Button variant="outline" size="sm" onClick={removeIcon} disabled={building}>
                  <X className="h-3 w-3 mr-1" /> Remove
                </Button>
              </div>
            ) : (
              <div
                className={`rounded-lg border-2 border-dashed transition-colors cursor-pointer ${
                  isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50'
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <div className="flex items-center justify-center gap-2 py-4 px-4">
                  <Upload className={`h-4 w-4 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
                  <p className="text-sm text-muted-foreground">
                    {isDragging ? 'Drop image here' : 'Drag & drop or click to upload'}
                  </p>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => processIconFile(e.target.files?.[0] || null)}
              disabled={building}
              className="hidden"
            />
            {!iconFile && (
              <p className="text-xs text-muted-foreground">Leave empty to use the default icon</p>
            )}
          </div>

          <div className="flex gap-2">
            <Button onClick={startBuild} disabled={building} className="flex-1" size="lg">
              {building ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Building...</>
              ) : (
                <><Wrench className="h-4 w-4 mr-2" /> Build APK</>
              )}
            </Button>
            {building && (
              <Button onClick={cancelBuild} variant="destructive" size="lg" disabled={cancelling}>
                {cancelling ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Cancelling...</>
                ) : (
                  <><StopCircle className="h-4 w-4 mr-2" /> Cancel</>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {(building || progress) && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center justify-between">
              <span className="flex items-center gap-2">
                {building ? (
                  <Loader2 className="h-5 w-5 text-primary animate-spin" />
                ) : progress?.complete ? (
                  progress.error ? (
                    <XCircle className="h-5 w-5 text-destructive" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-success" />
                  )
                ) : (
                  <Package className="h-5 w-5 text-muted-foreground" />
                )}
                Build Progress
              </span>
              {building && (
                <Badge variant="secondary" className="text-xs font-mono">{getOverallPercent()}%</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {BUILD_STEPS.map((step, index) => {
              const status = getStepStatus(step);
              const isLast = index === BUILD_STEPS.length - 1;
              return (
                <div key={step} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                      status === 'active' ? 'bg-primary text-primary-foreground ring-4 ring-primary/10' :
                      status === 'done' ? 'bg-success/15 text-success' :
                      status === 'failed' ? 'bg-destructive/15 text-destructive' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {status === 'done' ? <CheckCircle2 className="h-4 w-4" /> :
                       status === 'failed' ? <XCircle className="h-4 w-4" /> :
                       status === 'active' ? <Loader2 className="h-4 w-4 animate-spin" /> :
                       <Info className="h-4 w-4" />}
                    </div>
                    {!isLast && (
                      <div className={`w-0.5 h-4 ${status === 'done' ? 'bg-success/40' : 'bg-muted'}`} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex items-center gap-2">
                      <p className={`text-sm font-medium ${
                        status === 'active' ? 'text-foreground' :
                        status === 'done' ? 'text-success' :
                        status === 'failed' ? 'text-destructive' :
                        'text-muted-foreground'
                      }`}>
                        {STEP_LABELS[step]}
                      </p>
                      {status === 'active' && (
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      )}
                    </div>
                    {status === 'active' && progress?.message && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{progress.message}</p>
                    )}
                    {status === 'failed' && progress?.error && (
                      <p className="text-xs text-destructive/80 mt-0.5 break-all">{progress.error}</p>
                    )}
                  </div>
                </div>
              );
            })}

            {building && (
              <div className="pt-2 border-t">
                <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-primary h-1.5 rounded-full transition-all duration-700"
                    style={{ width: `${getOverallPercent()}%` }}
                  />
                </div>
              </div>
            )}

            {progress?.complete && !progress.error && (
              <div className="mt-2 p-3 rounded-lg bg-success/10 border border-success/20 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                <p className="text-sm text-success font-medium">Build completed successfully!</p>
              </div>
            )}
            {progress?.complete && progress.error && (
              <div className="mt-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-destructive font-medium">Build failed</p>
                  <p className="text-xs text-destructive/80 mt-0.5 break-all">{progress.error}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {buildComplete && (
        <Card className="shadow-sm border-success/30">
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-success/15 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="h-5 w-5 text-success" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">APK Ready</h3>
                  <p className="text-xs text-muted-foreground">{appName}.apk is ready to download</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {downloading && (
                  <span className="text-xs text-muted-foreground">{downloadProgress}%</span>
                )}
                <Button onClick={downloadApk} disabled={downloading} className="gap-2">
                  {downloading ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Downloading...</>
                  ) : (
                    <><Download className="h-4 w-4" /> Download</>
                  )}
                </Button>
              </div>
            </div>
            {downloading && (
              <div className="mt-3">
                <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-primary h-2 rounded-full transition-all duration-300"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
