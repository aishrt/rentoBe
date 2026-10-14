import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { attachmentSchema, type FileAttachment } from '../../lib/model-fields.js';

/**
 * The `messages` collection (plan §3). System messages, such as pickup reminders, have no sender. A
 * message can be photos alone, with no text.
 */
export interface Message {
  threadId: Types.ObjectId;
  senderId?: Types.ObjectId;
  body: string;
  attachments: FileAttachment[];
  systemGenerated: boolean;
  /** When the other participant read it. System messages don't have one. */
  readAt?: Date;
  /**
   * Removed by support after a report (plan §6.2: moderation). Both participants then see a notice instead of
   * the words and photos; staff still see the original, marked removed.
   */
  hiddenAt?: Date;
  hiddenBy?: Types.ObjectId;
  hiddenReason?: string;
  createdAt: Date;
}

const messageSchema = new Schema<Message>(
  {
    threadId: { type: Schema.Types.ObjectId, ref: 'Thread', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User' },
    body: { type: String, default: '', maxlength: 2000 },
    attachments: { type: [attachmentSchema], default: [] },
    systemGenerated: { type: Boolean, default: false },
    readAt: Date,
    hiddenAt: Date,
    hiddenBy: { type: Schema.Types.ObjectId, ref: 'User' },
    hiddenReason: { type: String, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ threadId: 1, createdAt: 1 });

export const MessageModel = model<Message>('Message', messageSchema);
export type MessageDocument = HydratedDocument<Message>;
