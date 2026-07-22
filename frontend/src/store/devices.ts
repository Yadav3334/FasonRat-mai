import { create } from 'zustand';
import type { ClientDevice, DashboardData } from '@/types';
import { dashboardApi, clientsApi } from '@/services/api';

interface DevicesState {
  onlineClients: ClientDevice[];
  offlineClients: ClientDevice[];
  stats: DashboardData['stats'] | null;
  selectedDevice: ClientDevice | null;
  isLoading: boolean;
  error: string | null;
  fetchDashboard: () => Promise<void>;
  fetchClients: () => Promise<void>;
  selectDevice: (device: ClientDevice | null) => void;
  deleteDevice: (id: string) => Promise<boolean>;
  onDeviceConnected: (id: string, model?: string, ip?: string) => void;
  onDeviceDisconnected: (id: string) => void;
}

let dashboardAbortController: AbortController | null = null;

export const useDevicesStore = create<DevicesState>((set, get) => ({
  onlineClients: [],
  offlineClients: [],
  stats: null,
  selectedDevice: null,
  isLoading: false,
  error: null,

  fetchDashboard: async () => {
    if (dashboardAbortController) {
      dashboardAbortController.abort();
    }
    dashboardAbortController = new AbortController();
    const signal = dashboardAbortController.signal;

    set({ isLoading: true, error: null });
    try {
      const res = await dashboardApi.getData({ signal });
      if (signal.aborted) return;
      if (res.data.success) {
        const data = res.data.data;
        set({
          onlineClients: data.onlineClients,
          offlineClients: data.offlineClients,
          stats: data.stats,
          isLoading: false,
        });
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      const msg = (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to load dashboard');
      set({ error: msg, isLoading: false });
    }
  },

  onDeviceConnected: (id, model, ip) => {
    set((state) => {
      const offlineIdx = state.offlineClients.findIndex((c) => c.id === id);
      if (offlineIdx >= 0) {
        const device = { ...state.offlineClients[offlineIdx], online: true, deviceModel: model || state.offlineClients[offlineIdx].deviceModel, ip: ip || state.offlineClients[offlineIdx].ip, lastSeen: new Date().toISOString() };
        return {
          onlineClients: [device, ...state.onlineClients],
          offlineClients: state.offlineClients.filter((_, i) => i !== offlineIdx),
        };
      }
      const alreadyOnline = state.onlineClients.find((c) => c.id === id);
      if (alreadyOnline) return state;
      const newDevice: ClientDevice = { id, ip: ip || '', country: null, city: null, timezone: null, deviceModel: model || null, deviceBrand: null, deviceVersion: null, online: true, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), reconnectCount: 0, fasonHidden: false, cameraPermission: false, currentPath: '', gpsInterval: 0 };
      return { onlineClients: [newDevice, ...state.onlineClients] };
    });
    get().fetchDashboard();
  },

  onDeviceDisconnected: (id) => {
    set((state) => {
      const onlineIdx = state.onlineClients.findIndex((c) => c.id === id);
      if (onlineIdx < 0) return state;
      const device = { ...state.onlineClients[onlineIdx], online: false, lastSeen: new Date().toISOString() };
      return {
        onlineClients: state.onlineClients.filter((_, i) => i !== onlineIdx),
        offlineClients: [device, ...state.offlineClients],
      };
    });
    get().fetchDashboard();
  },

  fetchClients: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await clientsApi.getAll();
      if (res.data.success) {
        const data = res.data.data;
        const online = data.clients.filter((c: ClientDevice) => c.online);
        const offline = data.clients.filter((c: ClientDevice) => !c.online);
        set({
          onlineClients: online,
          offlineClients: offline,
          // Preserve existing stats from fetchDashboard, only update client counts
          stats: data.clients ? {
            ...(get().stats || {}),
            totalClients: data.total,
            onlineClients: data.online,
            offlineClients: data.offline,
          } as DashboardData['stats'] : get().stats,
          isLoading: false,
        });
      }
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to load clients');
      set({ error: msg, isLoading: false });
    }
  },

  selectDevice: (device) => set({ selectedDevice: device }),

  deleteDevice: async (id) => {
    try {
      const res = await clientsApi.delete(id);
      if (res.data.success) {
        set((state) => ({
          onlineClients: state.onlineClients.filter(c => c.id !== id),
          offlineClients: state.offlineClients.filter(c => c.id !== id),
          selectedDevice: state.selectedDevice?.id === id ? null : state.selectedDevice,
        }));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },
}));
