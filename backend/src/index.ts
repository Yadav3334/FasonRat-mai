import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { getConfig, loadPersistedSettings } from './config/index.js';
import { initDb, closeDb } from './db/index.js';
import { seedDefaultUser } from './db/seed.js';
import { authMiddleware, stopSessionCleanup } from './middleware/auth.js';
import registerPlugins from './plugins/index.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { deviceRoutes } from './routes/device.js';
import { settingsRoutes } from './routes/settings.js';
import { logsRoutes } from './routes/logs.js';
import { builderRoutes } from './routes/builder.js';
import { fileRoutes } from './routes/files.js';
import { statsRoutes } from './routes/stats.js';
import { socketService } from './services/socket.js';
import { taskManager } from './services/tasks.js';
import { ensureDataDir } from './config/paths.js';
import { log } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');

async function main() {
  const config = getConfig();

  ensureDataDir();
  initDb();
  loadPersistedSettings();
  await seedDefaultUser();

  const app = Fastify({ logger: false });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    const message = statusCode === 500 ? 'Internal server error' : (error as Error).message;
    if (statusCode === 500) {
      log.error(`Unhandled error: ${(error as Error).message}`, (error as Error).stack || '');
    }
    reply.code(statusCode).send({ success: false, error: message });
  });

  await registerPlugins(app);
  app.decorate('auth', authMiddleware);

  app.get('/api/health', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });

  await app.register(authRoutes, { prefix: '' });
  await app.register(userRoutes, { prefix: '' });
  await app.register(dashboardRoutes, { prefix: '' });
  await app.register(deviceRoutes, { prefix: '' });
  await app.register(settingsRoutes, { prefix: '' });
  await app.register(logsRoutes, { prefix: '' });
  await app.register(builderRoutes, { prefix: '' });
  await app.register(fileRoutes, { prefix: '' });
  await app.register(statsRoutes, { prefix: '' });

  if (fs.existsSync(FRONTEND_DIST)) {
    await app.register(fastifyStatic, {
      root: FRONTEND_DIST,
      prefix: '/',
      wildcard: false,
    });

    let cachedIndexHtml: string | null = null;
    try {
      cachedIndexHtml = fs.readFileSync(path.join(FRONTEND_DIST, 'index.html'), 'utf-8');
    } catch {
      log.warn('Could not read index.html for SPA fallback');
    }

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/socket.io')) {
        reply.code(404).send({ success: false, error: 'Not found' });
        return;
      }
      if (cachedIndexHtml) {
        reply.type('text/html').send(cachedIndexHtml);
      } else {
        reply.code(404).send({ success: false, error: 'Not found' });
      }
    });

    log.info('Serving frontend from ' + FRONTEND_DIST);
  }

  const port = config.port;
  const host = '0.0.0.0';

  await app.listen({ port, host });
  log.info(`FasonRat Backend running on http://${host}:${port}`);

  socketService.initialize(app.server, app);
  log.info('Socket.IO server initialized');

  taskManager.startAll();

  const shutdown = async () => {
    log.info('Shutting down...');
    try {
      taskManager.stopAll();
      socketService.shutdown();
      stopSessionCleanup();
      await app.close();
      closeDb();
    } finally {
      process.exit(0);
    }
  };

  let shuttingDown = false;
  const safeShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdown();
  };

  process.on('SIGTERM', safeShutdown);
  process.on('SIGINT', safeShutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
