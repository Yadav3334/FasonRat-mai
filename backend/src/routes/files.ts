import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/index.js';
import { clients, clientFiles } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import type { JwtPayload, Permission } from '../types/index.js';

/** Map plural URL segment → singular DB fileType value */
const FILE_TYPE_MAP: Record<string, string> = {
  photos: 'photo',
  recordings: 'recording',
  downloads: 'download',
};

const VALID_TYPES = Object.keys(FILE_TYPE_MAP);

export async function fileRoutes(app: FastifyInstance) {
  app.get('/api/files/:type/:id/:fileId', {
    preHandler: [app.auth, requirePermission('files:download')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { type, id, fileId } = request.params as { type: string; id: string; fileId: string };

    if (!VALID_TYPES.includes(type)) {
      return reply.code(400).send({ success: false, error: `Invalid file type. Must be one of: ${VALID_TYPES.join(', ')}` });
    }

    if (!checkDeviceAccess(request, id)) {
      return reply.code(403).send({ success: false, error: 'Insufficient permissions for this device' });
    }

    const dbFileType = FILE_TYPE_MAP[type];
    return serveFileFromDb(reply, id, parseInt(fileId, 10), dbFileType);
  });
}

function checkDeviceAccess(request: FastifyRequest, clientId: string): boolean {
  const user = request.user as JwtPayload | undefined;
  if (!user) return false;

  // Verify the device actually exists in the database
  const d = getDb();
  const device = d.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get();
  if (!device) return false;

  if (user.role === 'admin') return true;
  return hasPermission(user, 'files:download' as Permission) && hasPermission(user, 'device:view' as Permission);
}

function serveFileFromDb(reply: FastifyReply, clientId: string, fileId: number, fileType: string) {
  const d = getDb();
  const file = d.select({
    id: clientFiles.id,
    originalName: clientFiles.originalName,
    mimeType: clientFiles.mimeType,
    fileSize: clientFiles.fileSize,
    data: clientFiles.data,
  })
    .from(clientFiles)
    .where(and(
      eq(clientFiles.clientId, clientId),
      eq(clientFiles.id, fileId),
      eq(clientFiles.fileType, fileType),
    ))
    .get();

  if (!file || !file.data) {
    return reply.code(404).send({ success: false, error: 'File not found' });
  }

  const data = file.data as Buffer;
  const contentType = file.mimeType || 'application/octet-stream';
  const safeName = (file.originalName || 'file').replace(/"/g, "'");

  reply.header('Content-Type', contentType);
  reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
  reply.header('Content-Length', file.fileSize || data.length);
  return reply.send(Buffer.from(data));
}
