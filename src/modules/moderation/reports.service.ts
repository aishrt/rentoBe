import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { MessageModel } from '../messages/message.model.js';
import { ThreadModel } from '../messages/thread.model.js';
import { raiseRiskFlag } from '../risk/risk-flags.js';
import { ReviewModel } from '../reviews/review.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { ReportModel } from './report.model.js';
import type { ReportInput } from './reports.schemas.js';

/*
 * Reporting and blocking (spec §13, plan §14 messaging safety). A report goes to the moderation queue in
 * the staff portal; several people reporting the same person raises a risk flag for admins.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const notFound = () => new HttpError(404, 'NOT_FOUND', "We couldn't find what you're reporting.");

/** Who a report is about, after checking the reporter may report it. */
async function subjectOf(reporterId: string, input: ReportInput): Promise<Types.ObjectId> {
  switch (input.targetType) {
    case 'USER': {
      const user = await UserModel.findById(input.targetId).select('_id').lean();
      if (!user) throw notFound();
      return user._id;
    }
    case 'MESSAGE': {
      // Only someone in the conversation can report one of its messages.
      const message = await MessageModel.findById(input.targetId).select('threadId senderId').lean();
      const thread = message
        ? await ThreadModel.findById(message.threadId).select('participantIds').lean()
        : null;
      if (!message?.senderId || !thread?.participantIds.some((id) => id.equals(reporterId))) throw notFound();
      return message.senderId;
    }
    case 'REVIEW': {
      const review = await ReviewModel.findById(input.targetId).select('authorId status subjectId').lean();
      if (!review || (review.status !== 'PUBLISHED' && !review.subjectId.equals(reporterId)))
        throw notFound();
      return review.authorId;
    }
    case 'VEHICLE': {
      const vehicle = await VehicleModel.findById(input.targetId).select('hostId').lean();
      if (!vehicle) throw notFound();
      return vehicle.hostId;
    }
  }
}

/** POST /reports. Reporting the same thing twice keeps the first report. */
export async function createReport(reporterId: string, input: ReportInput, now = new Date()) {
  const subject = await subjectOf(reporterId, input);
  if (subject.equals(reporterId)) throw new HttpError(409, 'OWN_CONTENT', "You can't report yourself.");

  const existing = await ReportModel.findOne({
    reporterId,
    targetType: input.targetType,
    targetId: input.targetId,
    status: 'OPEN',
  });
  const report =
    existing ??
    (await ReportModel.create({
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      subjectUserId: subject,
      reason: input.reason,
      ...(input.note && { note: input.note }),
    }));

  // Several different people reporting one person in 90 days (plan §14: repeated user reports).
  const settings = await getPlatformSettings();
  const reporters = await ReportModel.distinct('reporterId', {
    subjectUserId: subject,
    status: mongoose.trusted({ $ne: 'DISMISSED' }),
    createdAt: mongoose.trusted({ $gte: new Date(now.getTime() - 90 * DAY_MS) }),
  });
  if (reporters.length >= settings.risk.reportsBeforeFlag) {
    await raiseRiskFlag(subject, 'REPEATED_REPORTS', `Reported by ${reporters.length} people in 90 days`, {
      now,
    });
  }
  return { id: report.id as string, status: 'OPEN' as const };
}

/** POST /users/{id}/block: no more messages from them; booking-critical system messages still arrive. */
export async function blockUser(userId: string, targetId: string): Promise<void> {
  if (!mongoose.isValidObjectId(targetId) || !(await UserModel.exists({ _id: targetId }))) {
    throw new HttpError(404, 'NOT_FOUND', "We couldn't find that member.");
  }
  if (targetId === userId) throw new HttpError(409, 'SELF', "You can't block yourself.");
  await UserModel.updateOne({ _id: userId }, { $addToSet: { blockedUserIds: targetId } });
}

export async function unblockUser(userId: string, targetId: string): Promise<void> {
  if (!mongoose.isValidObjectId(targetId)) return;
  await UserModel.updateOne({ _id: userId }, { $pull: { blockedUserIds: targetId } });
}

/** GET /me/blocked-users: the people the user has blocked, to unblock from their settings. */
export async function listBlockedUsers(userId: string) {
  const user = await UserModel.findById(userId).select('blockedUserIds').lean();
  const blocked = await UserModel.find({ _id: mongoose.trusted({ $in: user?.blockedUserIds ?? [] }) })
    .select('firstName avatarUrl')
    .lean();
  return blocked.map((person) => ({
    id: person._id.toString(),
    firstName: person.firstName,
    ...(person.avatarUrl && { avatarUrl: person.avatarUrl }),
  }));
}
