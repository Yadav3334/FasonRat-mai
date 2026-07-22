import { useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, ContactEntry } from '@/types';
import { CMD, normalizeContactList, extractList } from '@/types';
import { DevicePageHeader, EmptyState, ErrorAlert, LoadingSkeleton } from '@/components/device/shared';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Users, Search } from 'lucide-react';

export default function ContactsPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [search, setSearch] = useState('');

  const { data: contacts, loading, error, refresh, sendCommand, commandStatus } = useDeviceData<ContactEntry[]>({
    clientId,
    page: 'contacts',
    extractData: (d) => normalizeContactList(extractList(d.list)),
    dataType: 'contacts',
    defaultValue: [],
  });

  const fetchContacts = useCallback(async () => {
    await sendCommand(CMD.CONTACTS);
  }, [sendCommand]);

  const filteredContacts = useMemo(() => {
    if (!search) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(
      (c) => c.name.toLowerCase().includes(q) || c.number.toLowerCase().includes(q)
    );
  }, [contacts, search]);

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Contacts"
        subtitle={`${contacts.length} contacts`}
        actions={[
          { label: 'Fetch', icon: Users, onClick: fetchContacts, disabled: loading || !online },
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
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs w-full sm:w-48"
          />
        </div>
      </div>

      {loading && !error ? (
        <LoadingSkeleton rows={8} />
      ) : filteredContacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? 'No contacts match your search' : 'No contacts'}
          description={search ? 'Try a different search term' : 'Click Fetch to retrieve contacts'}
          action={!search ? { label: 'Fetch Contacts', onClick: fetchContacts, disabled: loading || !online, loading: commandStatus === 'sending' } : undefined}
        />
      ) : (
        <Card className="shadow-none overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs">Number</TableHead>
                <TableHead className="text-xs">Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredContacts.map((c, i) => (
                <TableRow key={`contact-${c.number}-${c.name}-${i}`}>
                  <TableCell className="font-medium text-xs">{c.name || '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{c.number || '-'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.type || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
