import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { clients, logs } from '../db/schema.js';
import { eq, count, gte } from 'drizzle-orm';
import { requirePermission } from '../middleware/auth.js';

export async function statsRoutes(app: FastifyInstance) {
  app.get('/api/stats', {
    preHandler: [app.auth, requirePermission('stats:view')],
  }, async () => {
    const d = getDb();

    const onlineClients = (d.select({ count: count() }).from(clients).where(eq(clients.online, true)).get())?.count ?? 0;
    const offlineClients = (d.select({ count: count() }).from(clients).where(eq(clients.online, false)).get())?.count ?? 0;
    const totalLogs = (d.select({ count: count() }).from(logs).get())?.count ?? 0;

    const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00.000Z';
    const todayLogs = (d.select({ count: count() }).from(logs).where(gte(logs.createdAt, todayStart)).get())?.count ?? 0;

    const memoryUsage = process.memoryUsage();

    return {
      success: true,
      data: {
        clients: {
          online: onlineClients,
          offline: offlineClients,
          total: onlineClients + offlineClients,
        },
        logs: {
          total: totalLogs,
          today: todayLogs,
        },
        system: {
          uptime: Math.floor(process.uptime()),
          memoryUsage: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          memoryTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memoryUsage.rss / 1024 / 1024),
          nodeVersion: process.version,
          platform: process.platform,
        },
      },
    };
  });
}
