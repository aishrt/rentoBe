import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { attachmentSchema, type FileAttachment } from '../../lib/model-fields.js';

export const INCIDENT_TYPES = [
  'DAMAGE',
  'ACCIDENT',
  'THEFT',
  'BREAKDOWN',
  'CLEANING',
  'FUEL',
  'LATE_RETURN',
  'NO_SHOW',
  'TOLL',
  'FINE',
  'DISPUTE',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_STATUSES = [
  'OPEN',
  'INVESTIGATING',
  'AWAITING_RESPONSE',
  'RESOLVED',
  'CLOSED',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** A case still being worked on: it holds payouts and keeps the booking's messages open (plan §3, §8). */
export const OPEN_INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'AWAITING_RESPONSE'] as const;

/** Who can see an event on the case: both parties, one of them, or support staff only. */
export const EVENT_VISIBILITIES = ['BOTH', 'GUEST', 'HOST', 'INTERNAL'] as const;

/** Case numbers look like IN-4F7K2Q. */
export const CASE_REF_PATTERN = /^IN-[A-Z0-9]{6}$/;

export interface IncidentEvent {
  actorId?: Types.ObjectId;
  action: string;
  note?: string;
  attachments: FileAttachment[];
  visibility: (typeof EVENT_VISIBILITIES)[number];
  /** The case's status after this event, when it changed it. */
  status?: IncidentStatus;
  /** On an ASSIGNED event: the staff member the case went to. */
  assigneeId?: Types.ObjectId;
  createdAt: Date;
}

/**
 * The `incidents` collection (plan §3, spec §15). `events` is the case's full history and is append-only
 * (plan §3, Key rules): the app only ever pushes to it.
 */
export interface Incident {
  caseRef: string;
  bookingId: Types.ObjectId;
  reporterId: Types.ObjectId;
  type: IncidentType;
  description: string;
  status: IncidentStatus;
  assignedTo?: Types.ObjectId;
  /** The check-out damage pins the case was opened with, so another case doesn't take them again. */
  damagePinIds?: Types.ObjectId[];
  events: IncidentEvent[];
  createdAt: Date;
  updatedAt: Date;
}

const incidentEventSchema = new Schema<IncidentEvent>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    note: { type: String, maxlength: 5000 },
    attachments: { type: [attachmentSchema], default: [] },
    visibility: { type: String, enum: EVENT_VISIBILITIES, default: 'BOTH' },
    status: { type: String, enum: INCIDENT_STATUSES },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const incidentSchema = new Schema<Incident>(
  {
    caseRef: { type: String, required: true, match: [CASE_REF_PATTERN, 'caseRef looks like IN-XXXXXX'] },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: INCIDENT_TYPES, required: true },
    description: { type: String, required: true, maxlength: 5000 },
    status: { type: String, enum: INCIDENT_STATUSES, default: 'OPEN' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    damagePinIds: { type: [Schema.Types.ObjectId], default: undefined },
    events: { type: [incidentEventSchema], default: [] },
  },
  { timestamps: true },
);

incidentSchema.index({ caseRef: 1 }, { unique: true });
incidentSchema.index({ bookingId: 1 });
incidentSchema.index({ status: 1, updatedAt: -1 });

export const IncidentModel = model<Incident>('Incident', incidentSchema);
export type IncidentDocument = HydratedDocument<Incident>;
