import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { MessageModel } from '../messages/message.model.js';
import { ThreadModel } from '../messages/thread.model.js';
import { ReportModel, type Report, type ReportStatus } from '../moderation/report.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import type { adminReportSchema } from './admin-ops.schemas.js';

/*
 * The moderation queue (spec §18; plan §9 Days 20–22): what members reported, with what was reported, so
 * support can act on it (hide a review, suspend someone, take a car down) or dismiss it, with a recorded
 * reason. A reported message's booking is given so its thread can be opened from the report.
 */

type Id = Types.ObjectId;
type ReportRecord = Report & { _id: Id };

const PREVIEW_LENGTH = 400;
const clip = (text: string) =>
  text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;

async function previews(reports: ReportRecord[]) {
  const ids = (type: Report['targetType']) =>
    reports.filter((report) => report.targetType === type).map((report) => report.targetId);
  const [messages, reviews, vehicles, users] = await Promise.all([
    MessageModel.find({ _id: mongoose.trusted({ $in: ids('MESSAGE') }) })
      .select('threadId body attachments')
      .lean(),
    ReviewModel.find({ _id: mongoose.trusted({ $in: ids('REVIEW') }) })
      .select('overall body')
      .lean(),
    VehicleModel.find({ _id: mongoose.trusted({ $in: ids('VEHICLE') }) })
      .select('year make model status')
      .lean(),
    UserModel.find({
      _id: mongoose.trusted({
        $in: [
          ...ids('USER'),
          ...reports.map((report) => report.reporterId),
          ...reports.flatMap((report) => report.subjectUserId ?? []),
        ],
      }),
    })
      .select('firstName lastName')
      .lean(),
  ]);
  const threads = await ThreadModel.find({
    _id: mongoose.trusted({ $in: messages.map((message) => message.threadId) }),
  })
    .select('bookingId')
    .lean();
  const bookings = await BookingModel.find({
    _id: mongoose.trusted({ $in: threads.map((thread) => thread.bookingId) }),
  })
    .select('ref')
    .lean();
  const name = (id: Id) => {
    const user = users.find((candidate) => candidate._id.equals(id));
    return user ? `${user.firstName} ${user.lastName}` : 'Former member';
  };
  const find = <T extends { _id: Id }>(list: T[], id: Id) => list.find((item) => item._id.equals(id));

  return (report: ReportRecord): { preview: string; bookingRef?: string } => {
    switch (report.targetType) {
      case 'MESSAGE': {
        const message = find(messages, report.targetId);
        if (!message) return { preview: 'The message has been deleted.' };
        const thread = threads.find((candidate) => candidate._id.equals(message.threadId));
        const booking = thread && bookings.find((candidate) => candidate._id.equals(thread.bookingId));
        const photos = message.attachments.length ? ` (${message.attachments.length} photo(s))` : '';
        return { preview: clip(`${message.body}${photos}`), ...(booking && { bookingRef: booking.ref }) };
      }
      case 'REVIEW': {
        const review = find(reviews, report.targetId);
        return {
          preview: review
            ? clip(`${review.overall}★ ${review.body ?? ''}`.trim())
            : 'The review has been deleted.',
        };
      }
      case 'VEHICLE': {
        const vehicle = find(vehicles, report.targetId);
        return {
          preview: vehicle
            ? `${vehicleTitle(vehicle)} (${vehicle.status.toLowerCase()})`
            : 'The car has been deleted.',
        };
      }
      default:
        return { preview: name(report.targetId) };
    }
  };
}

async function view(reports: ReportRecord[]): Promise<z.infer<typeof adminReportSchema>[]> {
  const preview = await previews(reports);
  const users = await UserModel.find({
    _id: mongoose.trusted({
      $in: [
        ...reports.map((report) => report.reporterId),
        ...reports.flatMap((report) => report.subjectUserId ?? []),
      ],
    }),
  })
    .select('firstName lastName')
    .lean();
  const person = (id: Id) => {
    const user = users.find((candidate) => candidate._id.equals(id));
    return { id: id.toString(), name: user ? `${user.firstName} ${user.lastName}` : 'Former member' };
  };
  return reports.map((report) => ({
    id: report._id.toString(),
    targetType: report.targetType,
    targetId: report.targetId.toString(),
    reason: report.reason,
    ...(report.note && { note: report.note }),
    status: report.status,
    reporter: person(report.reporterId),
    ...(report.subjectUserId && { subject: person(report.subjectUserId) }),
    ...preview(report),
    ...(report.resolution && { resolution: report.resolution }),
    createdAt: report.createdAt.toISOString(),
  }));
}

/** GET /admin/reports: open reports oldest first, or handled ones newest first. */
export async function listReports(status: ReportStatus = 'OPEN') {
  const reports = await ReportModel.find({ status })
    .sort({ createdAt: status === 'OPEN' ? 1 : -1 })
    .limit(200)
    .lean<ReportRecord[]>();
  return view(reports);
}

/** POST /admin/reports/{id}/resolve: actioned or dismissed, with what was done. */
export async function resolveReport(
  staffId: string,
  reportId: string,
  status: 'ACTIONED' | 'DISMISSED',
  resolution: string,
  ip?: string,
) {
  const report = mongoose.isValidObjectId(reportId) ? await ReportModel.findById(reportId) : null;
  if (!report) throw new HttpError(404, 'NOT_FOUND', 'No such report.');
  if (report.status !== 'OPEN')
    throw new HttpError(409, 'ALREADY_HANDLED', 'This report has already been handled.');
  report.status = status;
  report.resolution = resolution;
  report.handledBy = new mongoose.Types.ObjectId(staffId);
  report.handledAt = new Date();
  await report.save();
  await recordAudit({
    actorId: staffId,
    action: `report.${status.toLowerCase()}`,
    entity: 'report',
    entityId: report.id,
    after: { status, resolution },
    ...(ip && { ip }),
  });
  const [result] = await view([report.toObject() as ReportRecord]);
  return result!;
}
