import { authMiddleware } from '../middleware/auth.js';
import type { JwtPayload } from './index.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: typeof authMiddleware;
  }

  interface FastifyRequest {
    user?: JwtPayload;
  }
}
