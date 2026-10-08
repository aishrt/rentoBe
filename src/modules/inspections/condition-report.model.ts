import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const INSPECTION_STAGES = ['CHECK_IN', 'CHECK_OUT'] as const;
export type InspectionStage = (typeof INSPECTION_STAGES)[number];

export const INSPECTION_ANGLES = [
  'FRONT',
  'REAR',
  'DRIVER_SIDE',
  'PASSENGER_SIDE',
  'WHEELS',
  'WINDSCREEN',
  'INTERIOR',
  'DASHBOARD',
  'DAMAGE',
] as const;
export type InspectionAngle = (typeof INSPECTION_ANGLES)[number];

/** The angles every check-in and check-out photographs (plan §9, Days 19–21); damage photos are extra. */
export const REQUIRED_INSPECTION_ANGLES = [
  'FRONT',
  'REAR',
  'DRIVER_SIDE',
  'PASSENGER_SIDE',
  'WHEELS',
  'WINDSCREEN',
  'INTERIOR',
  'DASHBOARD',
] as const satisfies readonly InspectionAngle[];

/** Damage marked on the car diagram. x and y are percentages of the diagram's width and height. */
export interface DamagePin {
  _id?: Types.ObjectId;
  x: number;
  y: number;
  note?: string;
  /**
   * Found at check-out, not on the check-in report. Plan §3 calls it isNew, but Mongoose reserves that
   * name on every document.
   */
  newDamage: boolean;
  flaggedBy?: Types.ObjectId;
  /** When it was marked: with the report, or later, while the damage-report window is open. */
  flaggedAt?: Date;
}

export interface InspectionPhoto {
  angle: InspectionAngle;
  url: string;
  /** The Guest, the Host or a staff member. */
  takenBy: Types.ObjectId;
  /** The device clock in the capture flow. */
  takenAt: Date;
  exifTakenAt?: Date;
  /** Server time. */
  uploadedAt: Date;
  lat?: number;
  lng?: number;
}

/** The `conditionReports` collection (plan §3): the digital vehicle handover (spec §14). */
export interface ConditionReport {
  bookingId: Types.ObjectId;
  stage: InspectionStage;
  /** Who did the inspection: the Guest, the Host, or support staff completing a trip. */
  submittedBy?: Types.ObjectId;
  odometer: number;
  fuelOrBatteryPct: number;
  notes?: string;
  damagePins: DamagePin[];
  confirmedByGuestAt?: Date;
  confirmedByHostAt?: Date;
  /** The support staff member who completed a trip with a missing check-out (plan §8.2). */
  completedBy?: Types.ObjectId;
  photos: InspectionPhoto[];
  createdAt: Date;
  updatedAt: Date;
}

const damagePinSchema = new Schema<DamagePin>({
  x: { type: Number, min: 0, max: 100, required: true },
  y: { type: Number, min: 0, max: 100, required: true },
  note: { type: String, maxlength: 500 },
  newDamage: { type: Boolean, default: false },
  flaggedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  flaggedAt: Date,
});

const inspectionPhotoSchema = new Schema<InspectionPhoto>(
  {
    angle: { type: String, enum: INSPECTION_ANGLES, required: true },
    url: { type: String, required: true },
    takenBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    takenAt: { type: Date, required: true },
    exifTakenAt: Date,
    uploadedAt: { type: Date, required: true, default: Date.now },
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
  },
  { _id: false },
);

const conditionReportSchema = new Schema<ConditionReport>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    stage: { type: String, enum: INSPECTION_STAGES, required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    odometer: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'odometer must be a whole number' },
    },
    fuelOrBatteryPct: { type: Number, required: true, min: 0, max: 100 },
    notes: { type: String, maxlength: 2000 },
    damagePins: { type: [damagePinSchema], default: [] },
    confirmedByGuestAt: Date,
    confirmedByHostAt: Date,
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    photos: { type: [inspectionPhotoSchema], default: [] },
  },
  { collection: 'conditionReports', timestamps: true },
);

conditionReportSchema.index({ bookingId: 1, stage: 1 }, { unique: true });

export const ConditionReportModel = model<ConditionReport>('ConditionReport', conditionReportSchema);
export type ConditionReportDocument = HydratedDocument<ConditionReport>;
