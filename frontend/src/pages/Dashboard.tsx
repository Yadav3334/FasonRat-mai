import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDevicesStore } from '@/store/devices';
import { useAuthStore } from '@/store/auth';
import { getQuickActions } from '@/config/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Users, Wifi, WifiOff, Clock, RefreshCw,
  Activity, Zap, Smartphone, ArrowRight,
  ShieldCheck, UserCog,
} from 'lucide-react';
import { formatTime } from '@/lib/utils';

export default function DashboardPage() {
  const { stats, isLoading, fetchDashboard } = useDevicesStore();
  const { user, hasPermission } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  const statCards = [
    { title: 'Total Devices', value: stats?.totalClients || 0, icon: Users, color: 'text-primary', bg: 'bg-primary/10', hover: 'hover:shadow-primary/10' },
    { title: 'Online', value: stats?.onlineClients || 0, icon: Wifi, color: 'text-success', bg: 'bg-success/10', hover: 'hover:shadow-success/10' },
    { title: 'Offline', value: stats?.offlineClients || 0, icon: WifiOff, color: 'text-warning', bg: 'bg-warning/10', hover: 'hover:shadow-warning/10' },
    { title: 'Total Users', value: stats?.totalUsers || 0, icon: UserCog, color: 'text-blue-500', bg: 'bg-blue-500/10', hover: 'hover:shadow-blue-500/10' },
    { title: 'Admins', value: stats?.totalAdmins || 0, icon: ShieldCheck, color: 'text-orange-500', bg: 'bg-orange-500/10', hover: 'hover:shadow-orange-500/10' },
    { title: 'Uptime', value: stats ? formatTime(stats.uptime) : '0m', icon: Clock, color: 'text-primary', bg: 'bg-primary/10', hover: 'hover:shadow-primary/10' },
  ];

  const quickActions = getQuickActions(hasPermission);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {getGreeting()}, <span className="text-primary">{user?.username || 'Admin'}</span>
          </h1>
          <p className="text-muted-foreground mt-1">
            Here's an overview of your connected devices and system status.
          </p>
        </div>
        <Button onClick={fetchDashboard} variant="outline" disabled={isLoading} className="self-start">
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {statCards.map((stat) => (
          <Card
            key={stat.title}
            className={`border-0 shadow-sm hover:shadow-md transition-shadow duration-200 ${stat.hover}`}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{stat.title}</p>
                  <p className="text-2xl font-bold mt-1">{stat.value}</p>
                </div>
                <div className={`h-10 w-10 rounded-lg ${stat.bg} flex items-center justify-center`}>
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-success" />
                <span className="text-sm text-muted-foreground">System Status:</span>
                <Badge className="bg-success text-white border-0 text-xs">Operational</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                <span className="text-sm text-muted-foreground">Active Connections:</span>
                <span className="text-sm font-medium">{stats?.onlineClients || 0}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Memory Usage:</span>
                <span className="text-sm font-medium">{stats?.memoryUsage != null ? `${stats.memoryUsage} MB` : 'N/A'}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Quick Actions</p>
            <div className="grid grid-cols-2 gap-2">
              {quickActions.map((action) => (
                <Button
                  key={action.label}
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(action.to)}
                  className="justify-start"
                >
                  <action.icon className="h-3.5 w-3.5 mr-1.5" />
                  {action.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {hasPermission('device:view') && (
        <Card className="border-0 shadow-sm hover:shadow-md transition-shadow cursor-pointer" onClick={() => navigate('/devices')}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Smartphone className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">Manage Devices</h3>
                  <p className="text-sm text-muted-foreground">View and manage all your connected devices</p>
                </div>
              </div>
              <ArrowRight className="h-5 w-5 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
