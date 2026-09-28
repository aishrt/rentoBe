import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { attachmentSchema, type FileAttachment } from '../../lib/model-fields.js';

/** The `messages` collection (plan §3). System messages, such as pickup reminders, have no sender. */
export interface Message {
  threadId: Types.ObjectId;
  senderId?: Types.ObjectId;
  body: string;
  attachments: FileAttachment[];
  systemGenerated: boolean;
  readAt?: Date;
  createdAt: Date;
}

const messageSchema = new Schema<Message>(
  {
    threadId: { type: Schema.Types.ObjectId, ref: 'Thread', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User' },
    body: { type: String, required: true, maxlength: 2000 },
    attachments: { type: [attachmentSchema], default: [] },
    systemGenerated: { type: Boolean, default: false },
    readAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ threadId: 1, createdAt: 1 });

export const MessageModel = model<Message>('Message', messageSchema);
export type MessageDocument = HydratedDocument<Message>;
