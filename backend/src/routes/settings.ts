import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getConfig, updateConfig, parseConfigValue } from '../config/index.js';
import { requirePermission, getRequestUser } from '../middleware/auth.js';

// Only these keys are writable via the POST /api/config endpoint.
// Add entries here as new user-adjustable settings are introduced.
const ALLOWED_KEYS = [
  'logger.console.enabled',
];

// Only these keys are readable via the GET /api/config endpoint.
// Never expose secrets, JWT signing keys, or internal configuration.
const READABLE_KEYS = [
  'logger.console.enabled',
];

function filterConfig(full: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of READABLE_KEYS) {
    const parts = key.split('.');
    let src: Record<string, unknown> = full;
    let dst: Record<string, unknown> = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        if (src && typeof src === 'object' && part in src) {
          dst[part] = (src as Record<string, unknown>)[part];
        }
      } else {
        if (!dst[part] || typeof dst[part] !== 'object') dst[part] = {};
        dst = dst[part] as Record<string, unknown>;
        src = (src?.[part] as Record<string, unknown>) || {};
      }
    }
  }
  return result;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/config', {
    preHandler: [app.auth, async (request: any, reply: any) => {
      const user = request.user;
      if (user?.role !== 'admin') {
        return reply.code(403).send({ success: false, error: 'Admin access required to view configuration' });
      }
    }],
  }, async () => {
    return { success: true, data: filterConfig(getConfig() as unknown as Record<string, unknown>) };
  });

  app.post('/api/config', {
    preHandler: [app.auth, requirePermission('settings:edit')],
  }, async (request, reply) => {
    const { key, value } = (request.body || {}) as { key?: string; value?: string };

    if (!key || value == null) {
      return reply.code(400).send({ success: false, error: 'Key and value are required' });
    }

    if (!ALLOWED_KEYS.includes(key)) {
      return reply.code(403).send({ success: false, error: 'This setting cannot be changed from the UI' });
    }

    const parsedValue = parseConfigValue(value);
    updateConfig(key, parsedValue);

    const d = getDb();
    const existing = d.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get();
    if (existing) {
      d.update(settings).set({ value: String(value), updatedAt: new Date().toISOString() }).where(eq(settings.key, key)).run();
    } else {
      d.insert(settings).values({ key, value: String(value) }).run();
    }

    return { success: true, key, value: parsedValue };
  });
}
