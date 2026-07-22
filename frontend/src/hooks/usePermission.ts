import { useAuthStore } from '@/store/auth';
import type { Permission } from '@/types';

/** Check if the current user has a specific permission. Admins always return true. */
export function useCan(permission: Permission): boolean {
  const hasPermission = useAuthStore(state => state.hasPermission);
  return hasPermission(permission);
}

/** Check if the user has ALL of the specified permissions. */
export function useCanAll(...permissions: Permission[]): boolean {
  const hasPermission = useAuthStore(state => state.hasPermission);
  return permissions.every(p => hasPermission(p));
}

/** Check if the user has ANY of the specified permissions. */
export function useCanAny(...permissions: Permission[]): boolean {
  const hasPermission = useAuthStore(state => state.hasPermission);
  return permissions.some(p => hasPermission(p));
}
