import { Schema, model, type Types } from 'mongoose';

/**
 * Who did what, when and from where (plan §3 `auditLogs`, §14). Append-only: the app has no code
 * path that edits or deletes an entry; only the retention job removes entries past 7 years.
 */
export interface AuditLog {
  /** The user who acted. For their own account changes, the same as entityId. */
  actorId?: Types.ObjectId;
  /** Dotted and past tense, e.g. "password.changed", "mfa.reset", or "POST /admin/..." for staff writes. */
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
  },
  { collection: 'auditLogs', timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

export const AuditLogModel = model<AuditLog>('AuditLog', auditLogSchema);
