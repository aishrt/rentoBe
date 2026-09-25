import { pino } from 'pino';
import { env } from '../env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    censor: '[redacted]',
  },
  // Readable logs locally; structured JSON for CloudWatch everywhere else (plan §1.2).
  ...(env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
  }),
});
