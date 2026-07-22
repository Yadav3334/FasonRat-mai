import crypto from 'node:crypto';
import { getSqliteDb } from '../db/index.js';

const TOKEN_BYTES = 32;
const ENROLLMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type EnrollmentRow = {
  id: string;
  status: 'pending' | 'consumed' | 'revoked' | 'expired';
  device_id: string | null;
  expires_at: string;
};

type CredentialRow = {
  device_id: string;
  secret_hash: string;
  pending_secret_hash: string | null;
  status: 'active' | 'revoked';
  enrollment_id: string | null;
};

export class DeviceAuthError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}

function randomSecret(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function hashesEqual(left: string | null, right: string): boolean {
  if (!left || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function createPendingEnrollment(appName: string): {
  id: string;
  token: string;
  expiresAt: string;
} {
  const db = getSqliteDb();
  const id = crypto.randomUUID();
  const token = randomSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO device_enrollments
      (id, token_hash, status, app_name, created_at, expires_at)
    VALUES (?, ?, 'pending', ?, ?, ?)
  `).run(id, hashSecret(token), appName, now.toISOString(), expiresAt);

  return { id, token, expiresAt };
}

export function revokeEnrollment(enrollmentId: string): void {
  getSqliteDb().prepare(`
    UPDATE device_enrollments
    SET status = 'revoked'
    WHERE id = ? AND status = 'pending'
  `).run(enrollmentId);
}

export function provisionDevice(bootstrapToken: string, deviceId: string): string {
  const db = getSqliteDb();

  const result = db.transaction((): { deviceSecret?: string; error?: DeviceAuthError } => {
    const enrollment = db.prepare(`
      SELECT id, status, device_id, expires_at
      FROM device_enrollments
      WHERE token_hash = ?
    `).get(hashSecret(bootstrapToken)) as EnrollmentRow | undefined;

    if (!enrollment) throw new DeviceAuthError('Invalid enrollment token', 401);
    if (enrollment.status !== 'pending') {
      throw new DeviceAuthError('Enrollment token is no longer available', 409);
    }
    if (Date.parse(enrollment.expires_at) <= Date.now()) {
      db.prepare(`UPDATE device_enrollments SET status = 'expired' WHERE id = ?`).run(enrollment.id);
      return { error: new DeviceAuthError('Enrollment token has expired', 410) };
    }
    if (enrollment.device_id && enrollment.device_id !== deviceId) {
      throw new DeviceAuthError('Enrollment token is already bound to another device', 409);
    }

    const deviceSecret = randomSecret();
    const secretHash = hashSecret(deviceSecret);
    const now = new Date().toISOString();
    const existing = db.prepare(`
      SELECT device_id, secret_hash, pending_secret_hash, status, enrollment_id
      FROM device_credentials
      WHERE device_id = ?
    `).get(deviceId) as CredentialRow | undefined;

    if (existing?.status === 'active') {
      // Keep the current secret usable until the newly enrolled client proves it
      // received the replacement. Authentication promotes this pending hash.
      db.prepare(`
        UPDATE device_credentials
        SET pending_secret_hash = ?, enrollment_id = ?, revoked_at = NULL
        WHERE device_id = ?
      `).run(secretHash, enrollment.id, deviceId);
    } else {
      db.prepare(`
        INSERT INTO device_credentials
          (device_id, secret_hash, pending_secret_hash, status, enrollment_id, created_at, revoked_at)
        VALUES (?, ?, NULL, 'active', ?, ?, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          secret_hash = excluded.secret_hash,
          pending_secret_hash = NULL,
          status = 'active',
          enrollment_id = excluded.enrollment_id,
          revoked_at = NULL
      `).run(deviceId, secretHash, enrollment.id, now);
    }

    db.prepare(`
      UPDATE device_enrollments
      SET device_id = ?
      WHERE id = ? AND status = 'pending'
    `).run(deviceId, enrollment.id);

    return { deviceSecret };
  })();

  if (result.error) throw result.error;
  if (!result.deviceSecret) throw new DeviceAuthError('Device enrollment failed', 500);
  return result.deviceSecret;
}

export function authenticateDevice(deviceId: string, deviceSecret: string): boolean {
  const db = getSqliteDb();

  return db.transaction(() => {
    const credential = db.prepare(`
      SELECT device_id, secret_hash, pending_secret_hash, status, enrollment_id
      FROM device_credentials
      WHERE device_id = ?
    `).get(deviceId) as CredentialRow | undefined;

    if (!credential || credential.status !== 'active') return false;

    const suppliedHash = hashSecret(deviceSecret);
    const matchesPending = hashesEqual(credential.pending_secret_hash, suppliedHash);
    const matchesActive = hashesEqual(credential.secret_hash, suppliedHash);
    if (!matchesPending && !matchesActive) return false;

    const now = new Date().toISOString();
    if (matchesPending) {
      db.prepare(`
        UPDATE device_credentials
        SET secret_hash = pending_secret_hash,
            pending_secret_hash = NULL,
            rotated_at = ?,
            last_used_at = ?
        WHERE device_id = ?
      `).run(now, now, deviceId);
    } else {
      db.prepare(`
        UPDATE device_credentials SET last_used_at = ? WHERE device_id = ?
      `).run(now, deviceId);
    }

    if (credential.enrollment_id) {
      db.prepare(`
        UPDATE device_enrollments
        SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'pending' AND device_id = ?
      `).run(now, credential.enrollment_id, deviceId);
    }

    return true;
  })();
}

export function rotateDeviceCredential(deviceId: string): string {
  const db = getSqliteDb();
  const credential = db.prepare(`
    SELECT status FROM device_credentials WHERE device_id = ?
  `).get(deviceId) as Pick<CredentialRow, 'status'> | undefined;
  if (!credential) throw new DeviceAuthError('Device credential not found', 404);
  if (credential.status !== 'active') throw new DeviceAuthError('Device credential is revoked', 409);

  const deviceSecret = randomSecret();
  db.prepare(`
    UPDATE device_credentials
    SET pending_secret_hash = ?
    WHERE device_id = ? AND status = 'active'
  `).run(hashSecret(deviceSecret), deviceId);
  return deviceSecret;
}

export function acknowledgeCredentialRotation(deviceId: string): boolean {
  const now = new Date().toISOString();
  const result = getSqliteDb().prepare(`
    UPDATE device_credentials
    SET secret_hash = pending_secret_hash,
        pending_secret_hash = NULL,
        rotated_at = ?,
        last_used_at = ?
    WHERE device_id = ? AND status = 'active' AND pending_secret_hash IS NOT NULL
  `).run(now, now, deviceId);
  return result.changes > 0;
}

export function cancelPendingCredentialRotation(deviceId: string): void {
  getSqliteDb().prepare(`
    UPDATE device_credentials
    SET pending_secret_hash = NULL
    WHERE device_id = ? AND status = 'active'
  `).run(deviceId);
}

export function revokeDeviceCredential(deviceId: string): boolean {
  const result = getSqliteDb().prepare(`
    UPDATE device_credentials
    SET status = 'revoked', pending_secret_hash = NULL, revoked_at = ?
    WHERE device_id = ? AND status = 'active'
  `).run(new Date().toISOString(), deviceId);
  return result.changes > 0;
}

export function deleteDeviceCredential(deviceId: string): void {
  getSqliteDb().prepare(`DELETE FROM device_credentials WHERE device_id = ?`).run(deviceId);
}
