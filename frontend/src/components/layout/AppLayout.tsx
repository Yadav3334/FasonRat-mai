import { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './sidebar';
import Header from './header';
import MobileNav from './mobile-nav';
import { useDevicesStore } from '@/store/devices';
import { initAdminSocket, disconnectAdminSocket } from '@/services/socket';
import type { Socket } from 'socket.io-client';

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { onDeviceConnected, onDeviceDisconnected } = useDevicesStore();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleDeviceChange = useCallback((payload: { id: string; model?: string; ip?: string; online: boolean }) => {
    if (payload.online) {
      onDeviceConnected(payload.id, payload.model, payload.ip);
    } else {
      onDeviceDisconnected(payload.id);
    }
  }, [onDeviceConnected, onDeviceDisconnected]);

  useEffect(() => {
    const s = initAdminSocket(handleDeviceChange);
    socketRef.current = s;

    return () => {
      disconnectAdminSocket();
      socketRef.current = null;
    };
  }, [handleDeviceChange]);

  return (
    <div className="h-screen overflow-hidden flex">
      <aside className="hidden lg:flex lg:shrink-0">
        <Sidebar />
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header onMobileMenuOpen={() => setMobileOpen(true)} />

        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="p-4 md:p-6 lg:p-8">
            <Outlet />
          </div>
        </main>


      </div>

      <MobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </div>
  );
}
