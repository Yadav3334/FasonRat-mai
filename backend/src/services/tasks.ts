import { socketService } from './socket.js';
import { dbHelpers, getSqliteDb } from '../db/index.js';
import { getConfig } from '../config/index.js';
import { log } from '../utils/logger.js';

interface Task {
  name: string;
  interval: number;
  handler: () => void | Promise<void>;
  stopOnError: boolean;
  timer?: NodeJS.Timeout;
}

class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private running = false;

  register(name: string, interval: number, handler: () => void | Promise<void>, stopOnError = true): void {
    this.tasks.set(name, { name, interval, handler, stopOnError });
  }

  startAll(): void {
    if (this.running) return;
    this.running = true;

    for (const [name, task] of this.tasks) {
      const timer = setInterval(async () => {
        try { await task.handler(); } catch (err: unknown) {
          log.error(`Task ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (task.stopOnError) { clearInterval(timer); this.tasks.delete(name); }
        }
      }, task.interval);

      this.tasks.set(name, { ...task, timer });
      log.info(`Task ${name} started (interval: ${task.interval}ms)`);
    }
  }

  stopAll(): void {
    for (const [, task] of this.tasks) { if (task.timer) clearInterval(task.timer); }
    this.tasks.clear();
    this.running = false;
    log.info('All tasks stopped');
  }
}

export const taskManager = new TaskManager();

taskManager.register('cleanup', 3600000, () => {
  const deleted = socketService.cleanupStaleClients();
  if (deleted > 0) log.info(`Cleaned up ${deleted} stale clients`);
  const sessions = dbHelpers.cleanExpiredSessions();
  if (sessions > 0) log.info(`Cleaned ${sessions} expired sessions`);
  dbHelpers.cleanLoginAttempts(getConfig().security.loginLockout);
});

taskManager.register('heartbeat', 30000, () => {
  try {
    // Use the in-memory socket map to determine connectivity — this avoids the
    // SELECT-then-UPDATE race where a device reconnects between the two queries.
    const d = getSqliteDb();
    const onlineInDb = d.prepare('SELECT id FROM clients WHERE online = 1').all() as Array<{ id: string }>;
    for (const client of onlineInDb) {
      if (!socketService.isClientConnected(client.id)) {
        d.prepare("UPDATE clients SET online = 0, last_seen = datetime('now') WHERE id = ?").run(client.id);
      }
    }
    // Also mark any connected client that was incorrectly set to offline
    const offlineInDb = d.prepare("SELECT id FROM clients WHERE online = 0").all() as Array<{ id: string }>;
    for (const client of offlineInDb) {
      if (socketService.isClientConnected(client.id)) {
        d.prepare("UPDATE clients SET online = 1, last_seen = datetime('now') WHERE id = ?").run(client.id);
      }
    }
  } catch { /* ignore */ }
}, false);

taskManager.register('transferCleanup', 300000, () => {
  socketService.cleanupStaleTransfers();
}, false);

taskManager.register('dbMaintenance', 3600000, () => {
  try {
    const d = getSqliteDb();
    d.pragma('optimize');
    log.info('Database maintenance completed');
  } catch (err: unknown) { log.error(`DB maintenance error: ${err instanceof Error ? err.message : String(err)}`); }
});
