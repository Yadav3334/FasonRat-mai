import { initDb, closeDb } from './index.js';
import { log } from '../utils/logger.js';

async function runMigrations() {
  log.info('Running database migrations...');
  initDb();
  // Add future migrations here
  log.info('Database migrations completed');
  closeDb();
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
