import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/** One chat thread per booking (plan §3 `threads`, spec §13). */
export interface Thread {
  bookingId: Types.ObjectId;
  participantIds: Types.ObjectId[];
  lastMessageAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const threadSchema = new Schema<Thread>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    participantIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    lastMessageAt: Date,
  },
  { timestamps: true },
);

threadSchema.index({ bookingId: 1 }, { unique: true });
// A user's inbox, newest first.
threadSchema.index({ participantIds: 1, lastMessageAt: -1 });

export const ThreadModel = model<Thread>('Thread', threadSchema);
export type ThreadDocument = HydratedDocument<Thread>;
