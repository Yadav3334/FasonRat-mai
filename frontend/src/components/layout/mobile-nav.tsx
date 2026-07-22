import { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { getNavItems } from '@/config/navigation';
import { LogOut, X, ShieldCheck, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

import type { UserRole } from '@/types';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

export default function MobileNav({ open, onClose }: MobileNavProps) {
  const { user, logout, hasPermission } = useAuthStore();
  const navigate = useNavigate();
  const role = user?.role || 'user' as UserRole;
  const navItems = getNavItems(hasPermission);

  useEffect(() => {
    if (open) { document.body.style.overflow = 'hidden'; } else { document.body.style.overflow = ''; }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  const handleLogout = async () => { await logout(); onClose(); navigate('/login'); };
  const handleNavClick = () => { onClose(); };
  const initial = user?.username?.[0]?.toUpperCase() || 'U';
  const RoleIcon = role === 'admin' ? ShieldCheck : Shield;

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="fixed inset-y-0 left-0 w-[280px] max-w-[85vw] bg-sidebar border-r border-sidebar-border shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 h-[57px] border-b border-sidebar-border shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-sidebar-foreground leading-tight">Control Panel</span>
          </div>
          <button onClick={onClose} className="text-sidebar-muted-foreground hover:text-sidebar-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3">
          <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted-foreground">Main</p>
          <div className="space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={handleNavClick}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-primary text-primary-foreground' : 'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="border-t border-sidebar-border p-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary text-sm font-bold shrink-0">
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.username || 'User'}</p>
              <div className="flex items-center gap-1">
                <RoleIcon className={`h-3 w-3 ${role === 'admin' ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className={`text-[10px] ${role === 'admin' ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                  {role === 'admin' ? 'Administrator' : 'User'}
                </span>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="text-sidebar-muted-foreground hover:text-sidebar-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
