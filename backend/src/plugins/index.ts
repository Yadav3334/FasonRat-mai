import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { getConfig } from '../config/index.js';
import { dbHelpers } from '../db/index.js';

async function plugins(app: FastifyInstance) {
  const config = getConfig();

  await app.register(cookie);

  const jwtSecret = dbHelpers.getOrCreateJwtSecret();
  await app.register(jwt, {
    secret: jwtSecret,
    cookie: {
      cookieName: 'token',
      signed: false,
    },
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || (config.socket.cors.origin === '*' ? false : config.socket.cors.origin) || 'http://localhost:5173',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'] as any,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: config.rateLimit.maxRequests,
    timeWindow: config.rateLimit.windowMs,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
    },
  });
}

export default fp(plugins, { name: 'app-plugins' });
