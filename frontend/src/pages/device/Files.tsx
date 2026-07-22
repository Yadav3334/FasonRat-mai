import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, FileEntry } from '@/types';
import { CMD, normalizeFileList, extractList } from '@/types';
import { DevicePageHeader, ErrorAlert, EmptyState, StatusBadge, LoadingSkeleton } from '@/components/device/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  FolderOpen, Download, ArrowLeft, ArrowRight,
  File, Folder, FolderSymlink, ChevronRight,
  Home, FileText, FileImage, FileVideo, FileAudio, FileArchive,
  FileCode, Loader2
} from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { onTransferUpdate } from '@/services/socket';

function getFileExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.substring(idx + 1).toLowerCase() : '';
}

function FileIcon({ file }: { file: FileEntry }) {
  if (file.isDir) {
    if (file.name === '../') return <FolderSymlink className="h-4 w-4 text-primary shrink-0" />;
    return <Folder className="h-4 w-4 text-primary shrink-0" />;
  }
  const ext = getFileExt(file.name);
  const c = "h-4 w-4 shrink-0";
  switch (ext) {
    case 'jpg': case 'jpeg': case 'png': case 'gif': case 'bmp': case 'webp': case 'svg':
      return <FileImage className={`${c} text-pink-500`} />;
    case 'mp4': case 'avi': case 'mkv': case 'mov': case '3gp': case 'wmv':
      return <FileVideo className={`${c} text-purple-500`} />;
    case 'mp3': case 'wav': case 'ogg': case 'flac': case 'aac': case 'm4a':
      return <FileAudio className={`${c} text-orange-500`} />;
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': case 'apk':
      return <FileArchive className={`${c} text-yellow-600`} />;
    case 'js': case 'ts': case 'py': case 'java': case 'html': case 'css': case 'json': case 'xml':
      return <FileCode className={`${c} text-blue-500`} />;
    case 'txt': case 'log': case 'md': case 'csv':
      return <FileText className={`${c} text-muted-foreground`} />;
    default:
      return <File className={`${c} text-muted-foreground`} />;
  }
}

function formatModifiedDate(file: FileEntry): string {
  if (file.date) return file.date;
  if (file.lastModified) {
    if (typeof file.lastModified === 'number') {
      return new Date(file.lastModified).toLocaleString();
    }
    return String(file.lastModified);
  }
  return '-';
}

function getFileTypeLabel(file: FileEntry): string {
  if (file.isDir) return file.name === '../' ? 'Parent' : 'Directory';
  const ext = getFileExt(file.name);
  if (!ext) return 'File';
  const typeMap: Record<string, string> = {
    jpg: 'Image', jpeg: 'Image', png: 'Image', gif: 'Image', bmp: 'Image', webp: 'Image', svg: 'Image',
    mp4: 'Video', avi: 'Video', mkv: 'Video', mov: 'Video', '3gp': 'Video', wmv: 'Video',
    mp3: 'Audio', wav: 'Audio', ogg: 'Audio', flac: 'Audio', aac: 'Audio', m4a: 'Audio',
    zip: 'Archive', rar: 'Archive', '7z': 'Archive', tar: 'Archive', gz: 'Archive', apk: 'APK',
    pdf: 'PDF', doc: 'Document', docx: 'Document', xls: 'Spreadsheet', xlsx: 'Spreadsheet',
    txt: 'Text', log: 'Log', md: 'Markdown', csv: 'CSV',
    js: 'Code', ts: 'Code', py: 'Code', java: 'Code', html: 'Code', css: 'Code', json: 'Code', xml: 'Code',
  };
  return typeMap[ext] || ext.toUpperCase();
}

const STORAGE_ROOT = '/storage/emulated/0';

export default function FilesPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [transferStatus, setTransferStatus] = useState<{ name: string; status: 'downloading' | 'success' | 'error'; progress?: number; message?: string } | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathSyncedRef = useRef(false);

  const { data: rawData, loading, error: hookError, refresh, sendCommand, commandStatus } = useDeviceData<{
    files: FileEntry[];
    path: string;
    serverError: string | null;
  }>({
    clientId,
    page: 'files',
    extractData: (d) => ({
      files: normalizeFileList(extractList(d.list)),
      path: (d.path as string) || '',
      serverError: (d.error as string) || null,
    }),
    dataType: 'files',
    defaultValue: { files: [], path: '', serverError: null },
  });

  const files = rawData.files;
  const serverPath = rawData.path;
  const serverError = rawData.serverError;

  useEffect(() => {
    if (serverPath && serverPath !== currentPath) {
      setCurrentPath(serverPath);
      setPathInput(serverPath);
      pathSyncedRef.current = true;
    }
  }, [serverPath]);

  useEffect(() => {
    if (serverError && files.length === 0 && !localError) {
      setLocalError(serverError);
    }
  }, [serverError, files.length, localError]);

  useEffect(() => {
    const unsub = onTransferUpdate((cid, transfer) => {
      if (cid === clientId) {
        setTransferStatus(prev => {
          if (prev?.status === 'downloading') return { ...prev, progress: transfer.progress };
          return prev;
        });
      }
    });
    return unsub;
  }, [clientId]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  const error = hookError || localError;

  const browseTo = async (path: string) => {
    setLocalError(null);
    try {
      await sendCommand(CMD.FILES, { action: 'ls', path });
    } catch {
      setLocalError('Failed to browse directory.');
    }
  };

  const downloadFile = async (filePath: string, fileName: string) => {
    setTransferStatus({ name: fileName, status: 'downloading' });
    try {
      await sendCommand(CMD.FILES, { action: 'dl', path: filePath });
      statusTimerRef.current = setTimeout(() => {
        setTransferStatus(prev => {
          if (prev?.status === 'downloading') return { name: fileName, status: 'success', message: 'Download initiated' };
          return prev;
        });
      }, 5000);
    } catch {
      setTransferStatus({ name: fileName, status: 'error', message: 'Failed to send download command' });
    }
  };

  const goUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    browseTo('/' + parts.join('/'));
  };

  const goHome = () => browseTo(STORAGE_ROOT);

  const handlePathSubmit = () => {
    browseTo(pathInput.trim() || STORAGE_ROOT);
  };

  const pathParts = currentPath.split('/').filter(Boolean);
  const dirCount = files.filter(f => f.isDir && f.name !== '../').length;
  const fileCount = files.filter(f => !f.isDir).length;

  return (
    <div className="space-y-4">
      <DevicePageHeader
        title="File Browser"
        subtitle={
          dirCount === 0 && fileCount === 0
            ? 'No items'
            : `${dirCount > 0 ? `${dirCount} folders` : ''}${dirCount > 0 && fileCount > 0 ? ' | ' : ''}${fileCount > 0 ? `${fileCount} files` : ''}`
        }
        actions={[
          { label: '', icon: Home, onClick: goHome, disabled: loading || !online, variant: 'outline', className: 'h-8 w-8 px-2' },
        ]}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {error && <ErrorAlert message={error} onRetry={refresh} />}

      {transferStatus && (
        <div className="flex items-center gap-2">
          <StatusBadge
            label={
              transferStatus.status === 'downloading'
                ? `Downloading ${transferStatus.name}... ${transferStatus.progress ?? 0}%`
                : transferStatus.status === 'success'
                  ? (transferStatus.message || `${transferStatus.name} downloaded`)
                  : (transferStatus.message || `Failed to download ${transferStatus.name}`)
            }
            status={transferStatus.status === 'downloading' ? 'warning' : transferStatus.status === 'success' ? 'success' : 'danger'}
          />
          {transferStatus.status === 'downloading' && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
          )}
        </div>
      )}

      <Card className="shadow-none">
        <CardContent className="p-2.5 space-y-2">
          <div className="flex items-center gap-0.5 text-xs flex-wrap">
            <button onClick={goHome} className="text-muted-foreground hover:text-foreground px-1 py-0.5 rounded hover:bg-muted/50 transition-colors font-medium">
              Storage
            </button>
            {pathParts.map((part, idx) => {
              const partPath = '/' + pathParts.slice(0, idx + 1).join('/');
              const isLast = idx === pathParts.length - 1;
              return (
                <span key={`bc-${idx}`} className="flex items-center gap-0.5">
                  <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
                  {isLast ? (
                    <span className="text-foreground font-medium px-1 py-0.5">{part}</span>
                  ) : (
                    <button onClick={() => browseTo(partPath)} className="text-muted-foreground hover:text-foreground px-1 py-0.5 rounded hover:bg-muted/50 transition-colors">
                      {part}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          <div className="flex gap-1.5">
            <Button variant="outline" size="icon" onClick={goUp} className="h-8 w-8 shrink-0" disabled={loading || !currentPath || currentPath === '/'} aria-label="Go up">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handlePathSubmit()} className="flex-1 font-mono text-xs h-8" placeholder="/storage/emulated/0" disabled={loading} />
            <Button onClick={handlePathSubmit} size="sm" className="h-8 px-3" disabled={loading}>Go<ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>
          </div>
        </CardContent>
      </Card>

      {loading && !error ? (
        <LoadingSkeleton rows={6} />
      ) : files.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No files found"
          description="Browse storage to access device files"
          action={{ label: 'Browse Storage', onClick: () => browseTo(STORAGE_ROOT), disabled: loading || !online, loading: commandStatus === 'sending' }}
        />
      ) : (
        <Card className="shadow-none overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs w-[90px]">Size</TableHead>
                <TableHead className="text-xs hidden sm:table-cell w-[160px]">Modified</TableHead>
                <TableHead className="text-xs hidden md:table-cell w-[90px]">Type</TableHead>
                <TableHead className="w-[50px] text-xs">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file, i) => {
                const directory = file.isDir;
                const filePath = file.path || `${currentPath}/${file.name}`;
                const isParent = file.name === '../';
                return (
                  <TableRow key={`file-${file.name}-${file.path}-${i}`} className={directory ? 'cursor-pointer hover:bg-primary/5' : ''} onClick={() => directory && browseTo(filePath)}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <FileIcon file={file} />
                        <span className={`text-xs truncate max-w-[280px] ${directory ? 'font-medium text-primary' : 'text-foreground'}`}>
                          {isParent ? '.. (Parent)' : file.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {directory ? (isParent ? '-' : <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">DIR</Badge>) : formatBytes(file.size)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground hidden sm:table-cell whitespace-nowrap">{formatModifiedDate(file)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground hidden md:table-cell">{getFileTypeLabel(file)}</TableCell>
                    <TableCell>
                      {!directory && (
                        <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); downloadFile(filePath, file.name); }} className="h-7 w-7 hover:text-primary" aria-label="Download file">
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {files.length > 0 && (
        <div className="flex items-center justify-between text-[10px] text-muted-foreground/50 px-1">
          <span>Showing {files.length} items in <span className="font-mono">{currentPath}</span></span>
          <span>Chunked transfer — no size limit</span>
        </div>
      )}
    </div>
  );
}
