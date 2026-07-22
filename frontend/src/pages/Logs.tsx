import { useEffect, useState } from 'react';
import { logsApi } from '@/services/api';
import type { LogEntry } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FileText, RefreshCw, Trash2, Search, Filter } from 'lucide-react';
import { formatDate } from '@/lib/utils';

const logTypes = ['ALL', 'INFO', 'SUCCESS', 'ERROR', 'WARNING', 'CONNECTION', 'DISCONNECTION', 'COMMAND', 'DATA', 'AUTH'];
const logCategories = ['ALL', 'SYSTEM', 'CLIENT', 'SOCKET', 'QUEUE', 'HTTP', 'BUILD', 'SECURITY'];

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');

  const loadLogs = async (opts?: { type?: string; category?: string; search?: string }) => {
    setLoading(true);
    try {
      const res = await logsApi.getLogs({
        type: (opts?.type || typeFilter) !== 'ALL' ? (opts?.type || typeFilter) : undefined,
        category: (opts?.category || categoryFilter) !== 'ALL' ? (opts?.category || categoryFilter) : undefined,
        search: (opts?.search || search) || undefined,
        limit: 500,
      });
      if (res.data.success) setLogs(res.data.data || []);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    loadLogs({ type: typeFilter, category: categoryFilter });
  }, [typeFilter, categoryFilter]);

  const clearLogs = async () => {
    if (!confirm('Are you sure you want to clear all logs?')) return;
    await logsApi.clear();
    setLogs([]);
  };

  const handleSearch = () => {
    setSearch(searchInput);
    loadLogs({ search: searchInput });
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'ERROR': return <Badge variant="destructive">{type}</Badge>;
      case 'WARNING': return <Badge className="bg-warning text-white border-0">{type}</Badge>;
      case 'SUCCESS': return <Badge className="bg-success text-white border-0">{type}</Badge>;
      case 'CONNECTION': return <Badge className="bg-success text-white border-0">{type}</Badge>;
      case 'DISCONNECTION': return <Badge variant="secondary">{type}</Badge>;
      case 'INFO': return <Badge>{type}</Badge>;
      default: return <Badge variant="outline">{type}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Activity Logs</h1>
          <p className="text-muted-foreground mt-1">Monitor server activity and events</p>
        </div>
        <div className="flex gap-2 self-start">
          <Button onClick={() => loadLogs()} variant="outline" disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={clearLogs} variant="destructive" size="sm">
            <Trash2 className="h-4 w-4 mr-2" /> Clear
          </Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Search logs..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full sm:w-64"
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground shrink-0">Type:</span>
                <div className="flex flex-wrap gap-1">
                  {logTypes.map((type) => (
                    <Button
                      key={type}
                      variant={typeFilter === type ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setTypeFilter(type)}
                      className="text-xs h-7"
                    >
                      {type}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-muted-foreground shrink-0">Category:</span>
                <div className="flex flex-wrap gap-1">
                  {logCategories.map((cat) => (
                    <Button
                      key={cat}
                      variant={categoryFilter === cat ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setCategoryFilter(cat)}
                      className="text-xs h-7"
                    >
                      {cat}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <div className="py-12 text-center">
              <FileText className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-muted-foreground">No logs found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      {getTypeBadge(log.type)}
                    </TableCell>
                    <TableCell className="text-sm">{log.category}</TableCell>
                    <TableCell className="max-w-md truncate text-sm">{log.message}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(log.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
