import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/** PUSH is added after launch (plan §10.5, R1): notify() gets another channel adapter. */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export const NOTIFICATION_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'FAILED'] as const;

/**
 * One notification on one channel (plan §3 `notifications`, §7). The in-app ones make up the notification
 * centre; email and SMS delivery status comes back from the providers' webhooks by `providerRef`.
 */
export interface Notification {
  userId: Types.ObjectId;
  /** E.g. BOOKING_CONFIRMED. */
  type: string;
  channel: (typeof NOTIFICATION_CHANNELS)[number];
  payload: unknown;
  status: (typeof NOTIFICATION_STATUSES)[number];
  providerRef?: string;
  error?: string;
  sentAt?: Date;
  readAt?: Date;
  /**
   * Set by notify() on one event's notifications, e.g. `BOOKING_CONFIRMED:<bookingId>:<userId>`, so a
   * job that runs again never notifies twice.
   */
  dedupeKey?: string;
  /**
   * When the user deleted this in-app notification. It stays in the database, hidden from them, so
   * notify() still finds its dedupeKey and a job that runs again can't bring it back.
   */
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<Notification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'QUEUED' },
    providerRef: String,
    error: String,
    sentAt: Date,
    readAt: Date,
    dedupeKey: String,
    deletedAt: Date,
  },
  { timestamps: true, minimize: false },
);

// One notification per channel for each event.
notificationSchema.index(
  { dedupeKey: 1, channel: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

// The notification centre, newest first, a page at a time; deleted ones fall outside the index bounds.
notificationSchema.index({ userId: 1, channel: 1, deletedAt: 1, createdAt: -1, _id: -1 });
// The same for unread ones only, and the bell's unread count.
notificationSchema.index({ userId: 1, channel: 1, deletedAt: 1, readAt: 1, createdAt: -1, _id: -1 });
// Delivery status webhooks find the notification by the provider's message ID.
notificationSchema.index(
  { providerRef: 1 },
  { partialFilterExpression: { providerRef: { $type: 'string' } } },
);

export const NotificationModel = model<Notification>('Notification', notificationSchema);
export type NotificationDocument = HydratedDocument<Notification>;
