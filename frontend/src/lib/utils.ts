import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Sanitize a URL path segment by stripping dangerous characters */
export function sanitizePath(segment: string | number): string {
  return String(segment).replace(/[^a-zA-Z0-9._-]/g, '');
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: unknown): string {
  const num = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(k)), sizes.length - 1);
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** Coerce any value to a finite number, returning fallback if not possible. */
export function safeNum(val: unknown, fallback: number = 0): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function formatTime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

export function getCountryFlag(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '🌍';
  const codePoints = countryCode.toUpperCase().split('').map(
    char => 0x1F1E6 + char.charCodeAt(0) - 65
  );
  return String.fromCodePoint(...codePoints);
}
