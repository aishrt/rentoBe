import { MessageModel } from '../src/modules/messages/message.model.js';
import { UNREAD_EMAIL_DELAY_MS } from '../src/modules/messages/messages.service.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';

/*
 * Time passing in conversations: the unread-message job announces a message only once it's 10 minutes
 * old, and the clock can't be moved here, so the conversations are moved back in time instead.
 */

/**
 * Moves every conversation back by `ms`, as if that long had passed since: its messages, when each side
 * read it and when each was last sent an unread-message notice, so they stay in the same order.
 */
export async function timePasses(ms = UNREAD_EMAIL_DELAY_MS + 60_000) {
  const earlier = (path: string) => ({ $subtract: [path, ms] });
  const shifted = (field: string) => ({
    $map: {
      input: { $ifNull: [`$${field}`, []] },
      in: { $mergeObjects: ['$$this', { at: earlier('$$this.at') }] },
    },
  });
  await MessageModel.collection.updateMany({}, [{ $set: { createdAt: earlier('$createdAt') } }]);
  await MessageModel.collection.updateMany({ readAt: { $exists: true } }, [
    { $set: { readAt: earlier('$readAt') } },
  ]);
  await ThreadModel.collection.updateMany({}, [
    { $set: { reads: shifted('reads'), unreadNotices: shifted('unreadNotices') } },
  ]);
  await ThreadModel.collection.updateMany({ lastMessageAt: { $exists: true } }, [
    { $set: { lastMessageAt: earlier('$lastMessageAt') } },
  ]);
}
