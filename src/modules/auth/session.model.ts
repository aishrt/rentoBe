import { Schema, model, type Types } from 'mongoose';

/** A signed-in device. The refresh token itself is never stored, only its SHA-256 hash (plan §6.1). */
export interface Session {
  userId: Types.ObjectId;
  refreshTokenHash: string;
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<Session>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    userAgent: String,
    ip: String,
    // TTL index: MongoDB deletes the session once it expires.
    expiresAt: { type: Date, required: true, expires: 0 },
    lastUsedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const SessionModel = model<Session>('Session', sessionSchema);
