import type { RequestHandler } from 'express';
import { logger } from '../integrations/logger.js';
import { reportError } from '../integrations/sentry.js';
import { recordAudit } from '../modules/audit/audit.service.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records every successful admin and support write (plan §6.2): who, which route and record, and
 * from where. Services add entries with the before and after values where that matters.
 */
export const auditStaffWrites: RequestHandler = (req, res, next) => {
  if (!WRITES.has(req.method)) return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    recordAudit({
      actorId: req.auth?.userId,
      action: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`,
      entity: 'admin-request',
      entityId: Object.values(req.params).join('/') || undefined,
      ip: req.ip,
    }).catch((error: unknown) => {
      logger.error({ err: error }, 'Could not write the audit log');
      reportError(error, { tags: { area: 'audit-log' } });
    });
  });
  next();
};
