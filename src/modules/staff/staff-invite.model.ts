import { Schema, model, type Types } from 'mongoose';

/**
 * An invitation to join the support team (plan §6.2). Only the admin sends them, and accepting one
 * is the only way an account becomes Support: there's no sign-up for staff. Only the link token's
 * SHA-256 hash is stored, and an email has at most one open invitation; sending another replaces it.
 */
export interface StaffInvite {
  email: string;
  firstName: string;
  lastName: string;
  tokenHash: string;
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

const staffInviteSchema = new Schema<StaffInvite>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    tokenHash: { type: String, required: true, unique: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // TTL index: MongoDB deletes the invitation once it expires.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'staffInvites', timestamps: { createdAt: true, updatedAt: false } },
);

export const StaffInviteModel = model<StaffInvite>('StaffInvite', staffInviteSchema);
