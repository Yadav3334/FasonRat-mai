import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../db/seed.js';
import { requirePermission, getRequestUser } from '../middleware/auth.js';
import { getDb, dbHelpers } from '../db/index.js';
import { users } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import { validateUsername, validatePasswordStrength, validateEmail } from '../utils/helpers.js';
import { ALL_PERMISSIONS, DEFAULT_USER_PERMISSIONS, PERMISSION_GROUPS, resolvePermissions } from '../types/index.js';
import type { UserRole, Permission } from '../types/index.js';

export async function userRoutes(app: FastifyInstance) {
  const manageUsers = [app.auth, requirePermission('users:manage')];

  app.get('/api/users/permissions-schema', {
    preHandler: manageUsers,
  }, async () => {
    return {
      success: true,
      data: {
        permissions: ALL_PERMISSIONS,
        groups: PERMISSION_GROUPS,
        defaults: DEFAULT_USER_PERMISSIONS,
      },
    };
  });

  app.get('/api/users', {
    preHandler: manageUsers,
  }, async () => {
    const allUsers = dbHelpers.getAllUsers();
    return {
      success: true,
      data: allUsers.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        permissions: resolvePermissions(u.role as UserRole, u.permissions),
        isDefault: u.isDefault,
        createdAt: u.createdAt,
        lastLogin: u.lastLogin,
      })),
    };
  });

  app.post('/api/users', {
    preHandler: manageUsers,
  }, async (request, reply) => {
    const { username, email, password, role, permissions: reqPermissions } = (request.body || {}) as {
      username?: string;
      email?: string;
      password?: string;
      role?: UserRole;
      permissions?: Permission[];
    };

    if (!username || !email || !password) {
      return reply.code(400).send({ success: false, error: 'Username, email, and password are required' });
    }

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return reply.code(400).send({ success: false, error: usernameValidation.message });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return reply.code(400).send({ success: false, error: emailValidation.message });
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return reply.code(400).send({ success: false, error: passwordValidation.message });
    }

    const d = getDb();
    const existingUsername = d.select({ id: users.id }).from(users).where(sql`LOWER(${users.username}) = ${username.toLowerCase()}`).get();
    if (existingUsername) {
      return reply.code(409).send({ success: false, error: 'Username already exists' });
    }

    const existingEmail = d.select({ id: users.id }).from(users).where(sql`LOWER(${users.email}) = ${email.toLowerCase()}`).get();
    if (existingEmail) {
      return reply.code(409).send({ success: false, error: 'Email already exists' });
    }

    const userRole: UserRole = role === 'admin' ? 'admin' : 'user';

    let userPermissions: Permission[] | undefined;
    if (userRole === 'user' && reqPermissions) {
      if (!Array.isArray(reqPermissions)) {
        return reply.code(400).send({ success: false, error: 'Permissions must be an array' });
      }
      userPermissions = Array.from(new Set(reqPermissions.filter((p: string) => ALL_PERMISSIONS.includes(p as Permission))));
    }

    const hash = await hashPassword(password);
    const userId = dbHelpers.createUser(username, email, hash, userRole, userPermissions);

    dbHelpers.addLog('ADMIN', 'USER', `User ${username} created by admin`, JSON.stringify({ role: userRole }));

    return {
      success: true,
      data: {
        id: userId,
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        role: userRole,
      },
    };
  });

  app.put('/api/users/:id', {
    preHandler: manageUsers,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { username, email, role, permissions: reqPermissions } = (request.body || {}) as {
      username?: string;
      email?: string;
      role?: UserRole;
      permissions?: Permission[];
    };
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
      return reply.code(400).send({ success: false, error: 'Invalid user ID' });
    }

    const existingUser = dbHelpers.getUserById(userId);
    if (!existingUser) {
      return reply.code(404).send({ success: false, error: 'User not found' });
    }

    if (existingUser.isDefault === 1) {
      return reply.code(403).send({ success: false, error: 'Cannot edit the default admin account' });
    }

    const updates: { username?: string; email?: string; role?: UserRole; permissions?: string } = {};

    if (username !== undefined) {
      const validation = validateUsername(username);
      if (!validation.valid) {
        return reply.code(400).send({ success: false, error: validation.message });
      }
      const d = getDb();
      const existing = d.select({ id: users.id }).from(users).where(sql`LOWER(${users.username}) = ${username.toLowerCase()} AND ${users.id} != ${userId}`).get();
      if (existing) {
        return reply.code(409).send({ success: false, error: 'Username already taken' });
      }
      updates.username = username.toLowerCase();
    }

    if (email !== undefined) {
      const validation = validateEmail(email);
      if (!validation.valid) {
        return reply.code(400).send({ success: false, error: validation.message });
      }
      const d = getDb();
      const existing = d.select({ id: users.id }).from(users).where(sql`LOWER(${users.email}) = ${email.toLowerCase()} AND ${users.id} != ${userId}`).get();
      if (existing) {
        return reply.code(409).send({ success: false, error: 'Email already taken' });
      }
      updates.email = email.toLowerCase();
    }

    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) {
        return reply.code(400).send({ success: false, error: 'Invalid role. Must be admin or user' });
      }
      if (existingUser.role === 'admin' && role === 'user') {
        const adminCount = dbHelpers.getAdminCount();
        if (adminCount <= 1) {
          return reply.code(400).send({ success: false, error: 'Cannot demote the last admin' });
        }
      }
      updates.role = role;
      if (role === 'admin') {
        updates.permissions = JSON.stringify(ALL_PERMISSIONS);
      } else if (role === 'user' && !reqPermissions) {
        updates.permissions = JSON.stringify(DEFAULT_USER_PERMISSIONS);
      }
    }

    if (reqPermissions !== undefined && (updates.role === 'user' || (existingUser.role === 'user' && updates.role === undefined))) {
      if (!Array.isArray(reqPermissions)) {
        return reply.code(400).send({ success: false, error: 'Permissions must be an array' });
      }
      const validPerms = Array.from(new Set(reqPermissions.filter((p: string) => ALL_PERMISSIONS.includes(p as Permission))));
      updates.permissions = JSON.stringify(validPerms);
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ success: false, error: 'No fields to update' });
    }

    dbHelpers.updateUser(userId, updates);

    dbHelpers.addLog('ADMIN', 'USER', `User ${existingUser.username} updated by admin`, JSON.stringify(updates));

    return { success: true, message: 'User updated successfully' };
  });

  app.put('/api/users/:id/permissions', {
    preHandler: manageUsers,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { permissions: reqPermissions } = (request.body || {}) as { permissions?: Permission[] };
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
      return reply.code(400).send({ success: false, error: 'Invalid user ID' });
    }

    if (!Array.isArray(reqPermissions)) {
      return reply.code(400).send({ success: false, error: 'Permissions must be an array' });
    }

    const existingUser = dbHelpers.getUserById(userId);
    if (!existingUser) {
      return reply.code(404).send({ success: false, error: 'User not found' });
    }

    if (existingUser.role === 'admin') {
      return reply.code(400).send({ success: false, error: 'Admin permissions cannot be customized. Admins always have all permissions.' });
    }

    const validPerms = reqPermissions.filter((p: string) => ALL_PERMISSIONS.includes(p as Permission)) as Permission[];
    dbHelpers.updateUser(userId, { permissions: JSON.stringify(validPerms) });

    dbHelpers.addLog('ADMIN', 'PERMISSIONS', `Permissions updated for user ${existingUser.username}`, JSON.stringify({ permissions: validPerms }));

    return { success: true, message: 'Permissions updated successfully', data: { permissions: validPerms } };
  });

  app.put('/api/users/:id/password', {
    preHandler: manageUsers,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { password } = (request.body || {}) as { password?: string };
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
      return reply.code(400).send({ success: false, error: 'Invalid user ID' });
    }

    if (!password) {
      return reply.code(400).send({ success: false, error: 'Password is required' });
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return reply.code(400).send({ success: false, error: passwordValidation.message });
    }

    const existingUser = dbHelpers.getUserById(userId);
    if (!existingUser) {
      return reply.code(404).send({ success: false, error: 'User not found' });
    }

    if (existingUser.isDefault === 1) {
      return reply.code(403).send({ success: false, error: 'Cannot reset password of the default admin account' });
    }

    const hash = await hashPassword(password);
    dbHelpers.updateUserPassword(userId, hash);

    dbHelpers.addLog('ADMIN', 'USER', `Password reset for user ${existingUser.username} by admin`);

    return { success: true, message: 'Password reset successfully' };
  });

  app.delete('/api/users/:id', {
    preHandler: manageUsers,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const requestingUser = getRequestUser(request);
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
      return reply.code(400).send({ success: false, error: 'Invalid user ID' });
    }

    if (userId === requestingUser.userId) {
      return reply.code(400).send({ success: false, error: 'Cannot delete your own account' });
    }

    const existingUser = dbHelpers.getUserById(userId);
    if (!existingUser) {
      return reply.code(404).send({ success: false, error: 'User not found' });
    }

    if (existingUser.role === 'admin') {
      const adminCount = dbHelpers.getAdminCount();
      if (adminCount <= 1) {
        return reply.code(400).send({ success: false, error: 'Cannot delete the last admin' });
      }
    }

    dbHelpers.deleteUser(userId);

    dbHelpers.addLog('ADMIN', 'USER', `User ${existingUser.username} deleted by admin`);

    return { success: true, message: 'User deleted successfully' };
  });
}
