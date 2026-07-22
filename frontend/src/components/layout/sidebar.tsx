import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { getNavItems } from '@/config/navigation';
import { LogOut, ShieldCheck, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

import type { UserRole } from '@/types';

const RoleBadge = ({ role }: { role: UserRole }) => {
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-primary font-medium">
        <ShieldCheck className="h-3 w-3" /> Admin
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
      <Shield className="h-3 w-3" /> User
    </span>
  );
};

export default function Sidebar() {
  const { user, logout, hasPermission } = useAuthStore();
  const navigate = useNavigate();
  const role = user?.role || 'user';
  const navItems = getNavItems(hasPermission);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const initial = user?.username?.[0]?.toUpperCase() || 'U';

  return (
    <div className="flex flex-col w-[260px] h-full bg-sidebar border-r border-sidebar-border">
      <div className="flex items-center gap-3 px-5 h-[57px] border-b border-sidebar-border shrink-0">
        <span className="text-sm font-semibold text-sidebar-foreground leading-tight">Control Panel</span>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3">
        <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted-foreground">Main</p>
        <div className="space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
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
            <RoleBadge role={role} />
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
  );
}
