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
  },
  { timestamps: true, minimize: false },
);

// The notification centre: unread first, newest first.
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
// Delivery status webhooks find the notification by the provider's message ID.
notificationSchema.index(
  { providerRef: 1 },
  { partialFilterExpression: { providerRef: { $type: 'string' } } },
);

export const NotificationModel = model<Notification>('Notification', notificationSchema);
export type NotificationDocument = HydratedDocument<Notification>;
