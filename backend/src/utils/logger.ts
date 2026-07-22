import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  ...(isDev ? {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  } : {}),
  level: process.env.LOG_LEVEL || 'info',
});

export const log = {
  info: (msg: string, ...args: unknown[]) => logger.info(args.length > 0 ? { extra: args } : {}, msg),
  error: (msg: string, err?: unknown) => {
    const errorObj = err instanceof Error
      ? { error: err.message, stack: err.stack }
      : err !== undefined ? { error: String(err) } : {};
    logger.error(errorObj, msg);
  },
  warn: (msg: string, ...args: unknown[]) => logger.warn(args.length > 0 ? { extra: args } : {}, msg),
  debug: (msg: string, ...args: unknown[]) => logger.debug(args.length > 0 ? { extra: args } : {}, msg),
};
