import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { clientsApi } from '@/services/api';
import { onDataUpdate } from '@/services/socket';

interface UseDeviceDataOptions<T> {
  /** The device/client ID */
  clientId: string;
  /** The page name for the API call (e.g. 'sms', 'calls', 'contacts') */
  page: string;
  /** Extract the typed data from the API response */
  extractData: (data: Record<string, unknown>) => T;
  /** Socket event data type(s) to listen for. Can be a single string or array. */
  dataType: string | string[];
  /** Default value for data before loading completes */
  defaultValue: T;
  /** Minimum time (ms) between socket-triggered refreshes. Default: 500 */
  socketDebounceMs?: number;
  /** Time (ms) before cached data is considered stale. Default: 15000 */
  staleTimeMs?: number;
}

export type CommandStatus = 'idle' | 'sending' | 'sent' | 'queued' | 'error';

export interface DeviceDataState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** Manually refresh data from the server (shows loading indicator) */
  refresh: () => Promise<void>;
  /** Send a command to the device. Throws on failure so callers can handle errors. */
  sendCommand: (cmd: string, params?: Record<string, unknown>) => Promise<void>;
  /** Timestamp of the last successful data fetch */
  lastUpdated: number | null;
  /** Status of the last command sent via sendCommand */
  commandStatus: CommandStatus;
}

// ─── Module-level page data cache ───────────────────────────────
// Persists across tab switches so users see cached data instantly
// when navigating back to a previously loaded page.

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const pageCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 50;

/** Clear cached data for a specific client page (e.g. on device disconnect) */
export function invalidatePageCache(clientId?: string, page?: string): void {
  if (!clientId) {
    pageCache.clear();
    return;
  }
  if (!page) {
    // Clear all pages for this client
    for (const key of pageCache.keys()) {
      if (key.startsWith(`${clientId}:`)) pageCache.delete(key);
    }
    return;
  }
  pageCache.delete(`${clientId}:${page}`);
}

function pruneCache(): void {
  if (pageCache.size <= MAX_CACHE_SIZE) return;
  const entries = [...pageCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  for (const [key] of entries.slice(0, pageCache.size - MAX_CACHE_SIZE)) {
    pageCache.delete(key);
  }
}

// ─── Hook ────────────────────────────────────────────────────────

/**
 * Custom hook for device sub-page data fetching.
 *
 * Key improvements:
 * - **Page-level cache**: Tab switches return cached data instantly (stale-while-revalidate)
 * - **Debounced socket refresh**: Socket events don't trigger more than one refresh
 *   per `socketDebounceMs` (default 2s), preventing API thrashing from rapid events
 * - **Background refresh**: Socket-triggered refreshes don't show loading spinner
 *   if we already have data — just silently update in the background
 * - **AbortController**: Cancels in-flight requests on unmount or new request
 * - **sendCommand throws**: So callers can catch and show error toasts
 */
export function useDeviceData<T>({
  clientId,
  page,
  extractData,
  dataType,
  defaultValue,
  socketDebounceMs = 500,
  staleTimeMs = 15000,
}: UseDeviceDataOptions<T>): DeviceDataState<T> {
  const cacheKey = `${clientId}:${page}`;

  // Initialize from cache if available
  const [data, setData] = useState<T>(() => {
    const cached = pageCache.get(cacheKey);
    return cached ? (cached.data as T) : defaultValue;
  });
  const [loading, setLoading] = useState(() => !pageCache.has(cacheKey));
  const [error, setError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>('idle');
  const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(() => {
    const cached = pageCache.get(cacheKey);
    return cached?.timestamp ?? null;
  });

  // Store extractData in a ref so refresh callback is stable
  const extractDataRef = useRef(extractData);
  extractDataRef.current = extractData;

  // Memoize dataType array to prevent useEffect from re-running
  const dataTypes = useMemo(
    () => (Array.isArray(dataType) ? dataType : [dataType]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Array.isArray(dataType) ? dataType.join(',') : dataType]
  );

  // Track in-flight request for cancellation
  const abortRef = useRef<AbortController | null>(null);

  // Track last refresh time for socket debounce
  const lastRefreshRef = useRef(pageCache.has(cacheKey) ? (pageCache.get(cacheKey)?.timestamp ?? 0) : 0);

  // Track whether we have meaningful data (to decide loading spinner visibility)
  const hasDataRef = useRef(pageCache.has(cacheKey));
  hasDataRef.current = data !== defaultValue;

  const refresh = useCallback(async () => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    // Only show loading spinner if we don't already have data
    // (stale-while-revalidate: show old data while fetching new)
    const showSpinner = !hasDataRef.current;
    if (showSpinner) {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await clientsApi.getPage(clientId, page);
      // Check if this request was aborted (component unmounted or new request started)
      if (controller.signal.aborted) return;
      if (res.data.success) {
        const extracted = extractDataRef.current(res.data.data as Record<string, unknown>);
        setData(extracted);
        const now = Date.now();
        setLastUpdated(now);
        pageCache.set(cacheKey, { data: extracted, timestamp: now });
        pruneCache();
      } else {
        setError(res.data.error || 'Failed to load data');
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Failed to load data');
    }
    if (!controller.signal.aborted) {
      setLoading(false);
      lastRefreshRef.current = Date.now();
    }
  }, [clientId, page, cacheKey]);

  // Initial load — use cache if fresh enough, otherwise fetch
  useEffect(() => {
    const cached = pageCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < staleTimeMs) {
      // Cache is fresh — still do a background refresh but don't show spinner
      setLoading(false);
      refresh();
    } else {
      refresh();
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Socket listener with debounce — background refresh only
  useEffect(() => {
    const unsub = onDataUpdate((cid, type) => {
      if (cid === clientId && dataTypes.includes(type)) {
        const now = Date.now();
        // Debounce: skip if we refreshed less than socketDebounceMs ago
        if (now - lastRefreshRef.current < socketDebounceMs) return;
        // Background refresh: don't show loading spinner
        lastRefreshRef.current = now;
        refresh();
      }
    });
    return unsub;
  }, [clientId, refresh, dataTypes, socketDebounceMs]);

  const sendCommand = useCallback(
    async (cmd: string, params: Record<string, unknown> = {}) => {
      // Clear any previous command status timer
      if (commandTimerRef.current) {
        clearTimeout(commandTimerRef.current);
        commandTimerRef.current = null;
      }

      setCommandStatus('sending');
      try {
        const res = await clientsApi.sendCommand(clientId, cmd, params);
        // API returns { success, sent, queued }
        const sent = res.data?.sent ?? false;
        const queued = res.data?.queued ?? false;
        if (sent) {
          setCommandStatus('sent');
        } else if (queued) {
          setCommandStatus('queued');
        } else if (res.data?.sent === false) {
          setCommandStatus('error');
          throw new Error('Device is offline');
        } else {
          setCommandStatus('sent'); // Default to sent if no explicit info
        }
        // Auto-clear success status after 3 seconds
        commandTimerRef.current = setTimeout(() => setCommandStatus('idle'), 3000);
      } catch {
        setCommandStatus('error');
        // Auto-clear error status after 4 seconds
        commandTimerRef.current = setTimeout(() => setCommandStatus('idle'), 4000);
      }
    },
    [clientId]
  );

  // Clean up command status timer on unmount
  useEffect(() => {
    return () => {
      if (commandTimerRef.current) {
        clearTimeout(commandTimerRef.current);
      }
    };
  }, []);

  return {
    data,
    loading,
    error,
    refresh,
    sendCommand,
    lastUpdated,
    commandStatus,
  };
}
