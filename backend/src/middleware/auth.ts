import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDb, dbHelpers } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { resolvePermissions } from '../types/index.js';
import type { JwtPayload, UserRole, Permission } from '../types/index.js';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let token: string | undefined;

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    token = request.cookies.token;
  }

  // JWT from URL query is deliberately NOT accepted — it leaks tokens into logs & referrers.

  if (!token) {
    reply.code(401).send({ success: false, error: 'Authentication required' });
    return;
  }

  try {
    const decoded = request.server.jwt.verify(token) as JwtPayload;

    const user = dbHelpers.getUserById(decoded.userId);
    if (!user) {
      reply.clearCookie('token', { path: '/' });
      reply.code(401).send({ success: false, error: 'User not found' });
      return;
    }

    if (!decoded.sessionId) {
      reply.clearCookie('token', { path: '/' });
      reply.code(401).send({ success: false, error: 'Session expired. Please log in again.' });
      return;
    }

    const d = getDb();
    const activeSession = d.select({ token: sessions.token }).from(sessions)
      .where(eq(sessions.token, decoded.sessionId))
      .get();
    if (!activeSession) {
      reply.clearCookie('token', { path: '/' });
      reply.code(401).send({ success: false, error: 'Session expired. Please log in again.' });
      return;
    }

    const permissions = resolvePermissions(user.role as UserRole, user.permissions);

    request.user = {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role as UserRole,
      permissions,
    };
  } catch {
    reply.clearCookie('token', { path: '/' });
    reply.code(401).send({ success: false, error: 'Invalid token' });
  }
}

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.user as JwtPayload | undefined;
    if (!user) {
      reply.code(401).send({ success: false, error: 'Authentication required' });
      return;
    }
    if (!user.permissions || !user.permissions.includes(permission)) {
      reply.code(403).send({ success: false, error: 'Insufficient permissions' });
      return;
    }
  };
}

export function hasPermission(user: JwtPayload | undefined, permission: Permission): boolean {
  if (!user?.permissions) return false;
  return user.permissions.includes(permission);
}

/** Extract authenticated user from request (set by authMiddleware). */
export function getRequestUser(request: FastifyRequest): JwtPayload {
  return request.user as JwtPayload;
}

export function verifyJwtToken(token: string, jwtVerify: (token: string) => JwtPayload): JwtPayload | null {
  try {
    const decoded = jwtVerify(token);
    const dbUser = dbHelpers.getUserById(decoded.userId);
    if (!dbUser) return null;

    // Verify session still exists in DB after logout
    if (decoded.sessionId) {
      const d = getDb();
      const activeSession = d.select({ token: sessions.token }).from(sessions)
        .where(eq(sessions.token, decoded.sessionId))
        .get();
      if (!activeSession) return null;
    }

    const permissions = resolvePermissions(dbUser.role as UserRole, dbUser.permissions);
    return {
      userId: dbUser.id,
      username: dbUser.username,
      email: dbUser.email,
      role: dbUser.role as UserRole,
      permissions,
    };
  } catch {
    return null;
  }
}

let sessionCleanupTimer: NodeJS.Timeout | null = null;

export function startSessionCleanup(): void {
  if (sessionCleanupTimer) return;
  const config = getConfig();
  sessionCleanupTimer = setInterval(() => {
    try {
      dbHelpers.cleanExpiredSessions();
      dbHelpers.cleanLoginAttempts(config.security.loginLockout);
    } catch { /* ignore */ }
  }, 60000);
}

export function stopSessionCleanup(): void {
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer);
    sessionCleanupTimer = null;
  }
}
