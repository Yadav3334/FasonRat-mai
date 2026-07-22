import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './index.js';
import { users } from './schema.js';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from '../types/index.js';
import type { UserRole } from '../types/index.js';
import { log } from '../utils/logger.js';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Seed the default admin user on first run.
 *  The password is taken from ADMIN_SETUP_PASSWORD env var, or else a random
 *  24-char password is generated and logged ONCE.  The user is forced to change
 *  on first login via the `passwordMustChange` flag. */
export async function seedDefaultUser(): Promise<void> {
  const d = getDb();
  const existing = d.select({ id: users.id }).from(users).where(eq(users.isDefault, 1)).get();
  if (existing) {
    log.info('Primary admin already exists');
    return;
  }

  const envPassword = process.env.ADMIN_SETUP_PASSWORD;
  let password: string;
  let fromEnv: boolean;

  if (envPassword && envPassword.length >= 12) {
    password = envPassword;
    fromEnv = true;
  } else {
    password = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 24);
    fromEnv = false;
    log.warn('');
    log.warn('╔══════════════════════════════════════════════════════════════╗');
    log.warn('║  NO ADMIN_SETUP_PASSWORD ENV VAR SET — USING RANDOM PASSWORD ║');
    log.warn(`║  Admin password: ${password.padEnd(44)}║`);
    log.warn('║  Set ADMIN_SETUP_PASSWORD in environment for future deploys. ║');
    log.warn('║  This password is printed only ONCE and cannot be recovered. ║');
    log.warn('╚══════════════════════════════════════════════════════════════╝');
    log.warn('');
  }

  const hash = await hashPassword(password);
  d.insert(users).values({
    username: 'admin',
    email: 'admin@fason.com',
    password: hash,
    role: 'admin' as UserRole,
    permissions: JSON.stringify(ALL_PERMISSIONS),
    isDefault: 1,
  }).run();

  log.info(fromEnv
    ? 'Primary admin created from ADMIN_SETUP_PASSWORD — username: "admin"'
    : 'Primary admin created with random password — username: "admin"');
}
