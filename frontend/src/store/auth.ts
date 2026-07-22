import { create } from 'zustand';
import { authApi } from '@/services/api';
import { disconnectAdminSocket } from '@/services/socket';
import type { AuthUser, UserRole, Permission } from '@/types';
import { ALL_PERMISSIONS } from '@/types';

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isChecking: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  isAdmin: () => boolean;
  hasPermission: (permission: Permission) => boolean;
}

const VALID_ROLES: UserRole[] = ['admin', 'user'];
function isValidPermission(p: string): p is Permission {
  return ALL_PERMISSIONS.includes(p as Permission);
}

function safeParseUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem('auth-user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      localStorage.removeItem('auth-user');
      return null;
    }
    if (!parsed.username || typeof parsed.username !== 'string') {
      localStorage.removeItem('auth-user');
      return null;
    }
    if (!parsed.role || !VALID_ROLES.includes(parsed.role)) {
      localStorage.removeItem('auth-user');
      return null;
    }
    if (!Array.isArray(parsed.permissions)) {
      parsed.permissions = [];
    } else {
      parsed.permissions = parsed.permissions.filter(isValidPermission);
    }
    if (typeof parsed.id !== 'number' || !parsed.email) {
      localStorage.removeItem('auth-user');
      return null;
    }
    const cleanUser: AuthUser = {
      id: parsed.id,
      username: parsed.username,
      email: parsed.email,
      role: parsed.role,
      permissions: parsed.permissions,
    };
    return cleanUser;
  } catch {
    localStorage.removeItem('auth-user');
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: safeParseUser(),
  isAuthenticated: false, // Will be set by checkAuth; avoid optimistic flash
  isLoading: false,
  isChecking: true,
  error: null,

  login: async (username, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await authApi.login(username, password);
      if (res.data.success) {
        const data = res.data.data;
        // Store JWT token separately for socket auth (not in auth-user to limit XSS exposure)
        if (data.token) {
          localStorage.setItem('auth-token', data.token);
        }
        const userData: AuthUser = {
          id: data.id,
          username: data.username,
          email: data.email,
          role: data.role,
          permissions: data.permissions,
        };
        localStorage.setItem('auth-user', JSON.stringify(userData));
        set({ user: userData, isAuthenticated: true, isLoading: false, isChecking: false });
        return true;
      }
      set({ error: res.data.error || 'Login failed', isLoading: false });
      return false;
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Login failed');
      set({ error: msg, isLoading: false });
      return false;
    }
  },

  logout: async () => {
    try { await authApi.logout(); } catch { /* ignore */ }
    disconnectAdminSocket();
    localStorage.removeItem('auth-user');
    localStorage.removeItem('auth-token');
    set({ user: null, isAuthenticated: false, isChecking: false });
  },

  checkAuth: async () => {
    try {
      const res = await authApi.me();
      if (res.data.success) {
        const data = res.data.data;
        const userData: AuthUser = {
          id: data.id,
          username: data.username,
          email: data.email,
          role: data.role,
          permissions: data.permissions,
        };
        localStorage.setItem('auth-user', JSON.stringify(userData));
        set({ user: userData, isAuthenticated: true, isChecking: false });
      }
    } catch {
      localStorage.removeItem('auth-user');
      localStorage.removeItem('auth-token');
      set({ user: null, isAuthenticated: false, isChecking: false });
    }
  },

  clearError: () => set({ error: null }),

  isAdmin: () => {
    const user = get().user;
    return user?.role === 'admin';
  },

  hasPermission: (permission: Permission) => {
    const user = get().user;
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions?.includes(permission) ?? false;
  },
}));
