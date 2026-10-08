import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/** When one participant last read the thread; their unread messages are the other side's since then. */
export interface ThreadRead {
  userId: Types.ObjectId;
  at: Date;
}

/** One chat thread per booking (plan §3 `threads`, spec §13). */
export interface Thread {
  bookingId: Types.ObjectId;
  participantIds: Types.ObjectId[];
  lastMessageAt?: Date;
  reads: ThreadRead[];
  createdAt: Date;
  updatedAt: Date;
}

const threadSchema = new Schema<Thread>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    participantIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    lastMessageAt: Date,
    reads: {
      type: [
        new Schema<ThreadRead>(
          {
            userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

threadSchema.index({ bookingId: 1 }, { unique: true });
// A user's inbox, newest first.
threadSchema.index({ participantIds: 1, lastMessageAt: -1 });

export const ThreadModel = model<Thread>('Thread', threadSchema);
export type ThreadDocument = HydratedDocument<Thread>;
