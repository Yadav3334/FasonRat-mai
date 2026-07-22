import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { clients, logs, users } from '../db/schema.js';
import { eq, desc, count, gte } from 'drizzle-orm';
import { formatClient } from './device.js';
import { requirePermission } from '../middleware/auth.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', {
    preHandler: [app.auth, requirePermission('dashboard:view')],
  }, async () => {
    const d = getDb();

    const onlineClients = d.select().from(clients).where(eq(clients.online, true)).orderBy(desc(clients.lastSeen)).all();
    const offlineClients = d.select().from(clients).where(eq(clients.online, false)).orderBy(desc(clients.lastSeen)).all();

    const totalLogsResult = d.select({ count: count() }).from(logs).get();

    const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00.000Z';
    const todayLogsResult = d.select({ count: count() }).from(logs).where(gte(logs.createdAt, todayStart)).get();

    const totalUsersResult = d.select({ count: count() }).from(users).get();
    const totalAdminsResult = d.select({ count: count() }).from(users).where(eq(users.role, 'admin')).get();

    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();

    return {
      success: true,
      data: {
        onlineClients: onlineClients.map(formatClient),
        offlineClients: offlineClients.map(formatClient),
        stats: {
          totalClients: onlineClients.length + offlineClients.length,
          onlineClients: onlineClients.length,
          offlineClients: offlineClients.length,
          totalLogs: totalLogsResult?.count ?? 0,
          todayLogs: todayLogsResult?.count ?? 0,
          totalUsers: totalUsersResult?.count ?? 0,
          totalAdmins: totalAdminsResult?.count ?? 0,
          uptime: Math.floor(uptime),
          memoryUsage: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        },
      },
    };
  });
}
