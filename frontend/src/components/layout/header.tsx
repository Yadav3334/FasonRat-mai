import { useState, useRef, useEffect } from 'react';
import { useThemeStore } from '@/store/theme';
import { useAuthStore } from '@/store/auth';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Monitor, Check, LogOut, ShieldCheck, Shield } from 'lucide-react';
import type { UserRole } from '@/types';

const themeOptions = [
  { value: 'light' as const, label: 'Light', icon: Sun },
  { value: 'dark' as const, label: 'Dark', icon: Moon },
  { value: 'system' as const, label: 'System', icon: Monitor },
];

export default function Header({ onMobileMenuOpen }: { onMobileMenuOpen: () => void }) {
  const { theme, setTheme, resolvedTheme } = useThemeStore();
  const { user, logout, hasPermission } = useAuthStore();
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const role: UserRole = user?.role || 'user';
  const RoleIcon = role === 'admin' ? ShieldCheck : Shield;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) setThemeOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const ThemeIcon = resolvedTheme === 'dark' ? Moon : Sun;
  const initial = user?.username?.[0]?.toUpperCase() || 'U';

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-[57px] px-4 md:px-6 lg:px-8 border-b border-border bg-background/80 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <button
          onClick={onMobileMenuOpen}
          className="lg:hidden inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label="Open menu"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Dashboard
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div ref={themeRef} className="relative">
          <button
            onClick={() => setThemeOpen(!themeOpen)}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            aria-label="Toggle theme"
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
          {themeOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden">
              {themeOptions.map((option) => {
                const Icon = option.icon;
                const isActive = theme === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => { setTheme(option.value); setThemeOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1 text-left">{option.label}</span>
                    {isActive && <Check className="h-4 w-4 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div ref={userRef} className="relative">
          <button
            onClick={() => setUserOpen(!userOpen)}
            className="inline-flex items-center gap-2 h-9 rounded-lg px-2 border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-bold">
              {initial}
            </div>
            <span className="hidden sm:inline text-sm font-medium max-w-[120px] truncate">{user?.username || 'User'}</span>
          </button>
          {userOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <p className="text-sm font-medium">{user?.username || 'User'}</p>
                <p className="text-xs text-muted-foreground">{user?.email || ''}</p>
                <div className="flex items-center gap-1 mt-1">
                  <RoleIcon className={`h-3 w-3 ${role === 'admin' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`text-xs ${role === 'admin' ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                    {role === 'admin' ? 'Administrator' : 'User'}
                  </span>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-destructive hover:bg-accent transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
