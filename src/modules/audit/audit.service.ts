import type { Types } from 'mongoose';
import { AuditLogModel } from './audit-log.model.js';

export interface AuditEntry {
  actorId?: Types.ObjectId | string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * Adds an entry to the audit log (plan §14). Never pass secrets or passwords in before/after:
 * record that something changed, and which fields.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await AuditLogModel.create(entry);
}
