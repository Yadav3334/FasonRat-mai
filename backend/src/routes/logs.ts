import type { FastifyInstance } from 'fastify';
import { getDb, getSqliteDb } from '../db/index.js';
import { logs } from '../db/schema.js';
import { eq, desc, count, like, and } from 'drizzle-orm';
import { requirePermission } from '../middleware/auth.js';

function escapeLikeWildcards(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

export async function logsRoutes(app: FastifyInstance) {
  app.get('/api/logs', {
    preHandler: [app.auth, requirePermission('logs:view')],
  }, async (request) => {
    const query = request.query as {
      type?: string;
      category?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };

    const d = getDb();
    const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 1000);
    const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0);

    const conditions = [];
    if (query.type) conditions.push(eq(logs.type, query.type));
    if (query.category) conditions.push(eq(logs.category, query.category));
    if (query.search) conditions.push(like(logs.message, `%${escapeLikeWildcards(query.search)}%`));

    const result = d.select({
      id: logs.id,
      type: logs.type,
      category: logs.category,
      message: logs.message,
      details: logs.details,
      created_at: logs.createdAt,
    }).from(logs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(logs.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    return { success: true, data: result };
  });

  app.get('/api/logs/stats', {
    preHandler: [app.auth, requirePermission('logs:view')],
  }, async () => {
    const d = getDb();
    const raw = getSqliteDb();

    const stats = raw.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today,
        SUM(CASE WHEN datetime(created_at) > datetime('now', '-1 hour') THEN 1 ELSE 0 END) as last_hour,
        SUM(CASE WHEN type = 'ERROR' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN type = 'WARNING' THEN 1 ELSE 0 END) as warnings,
        SUM(CASE WHEN type = 'CONNECTION' THEN 1 ELSE 0 END) as connections,
        SUM(CASE WHEN type = 'DISCONNECTION' THEN 1 ELSE 0 END) as disconnections
      FROM logs
    `).get() as Record<string, number>;

    const byType = d.select({ type: logs.type, count: count() }).from(logs).groupBy(logs.type).orderBy(desc(count())).all();
    const byCategory = d.select({ category: logs.category, count: count() }).from(logs).groupBy(logs.category).orderBy(desc(count())).all();

    return {
      success: true,
      data: {
        total: stats?.total ?? 0,
        today: stats?.today ?? 0,
        lastHour: stats?.last_hour ?? 0,
        errors: stats?.errors ?? 0,
        warnings: stats?.warnings ?? 0,
        connections: stats?.connections ?? 0,
        disconnections: stats?.disconnections ?? 0,
        byType,
        byCategory,
      },
    };
  });

  app.post('/api/logs/clear', {
    preHandler: [app.auth, requirePermission('logs:clear')],
  }, async () => {
    const d = getDb();
    d.delete(logs).run();
    return { success: true, message: 'Logs cleared' };
  });
}
