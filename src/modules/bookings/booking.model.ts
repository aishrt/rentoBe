import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { cents, nzAddressSchema, signedCents, type NzAddress } from '../../lib/model-fields.js';
import { FUEL_POLICIES, type FuelPolicy } from '../vehicles/vehicle.model.js';

/** The booking lifecycle in plan §8.2. */
export const BOOKING_STATUSES = [
  'PAYMENT_PENDING',
  'PENDING',
  'CONFIRMED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'DECLINED',
  'EXPIRED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const CANCELLATION_REASONS = [
  'GUEST_CANCELLED',
  'HOST_CANCELLED',
  'REQUEST_WITHDRAWN',
  'GUEST_NO_SHOW',
  'HOST_NO_SHOW',
  'PLATFORM',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const EXTRA_CHARGE_TYPES = [
  'EXTRA_KM',
  'FUEL',
  'CLEANING',
  'LATE_RETURN',
  'DAMAGE',
  'TOLL',
  'FINE',
  'OTHER',
] as const;
export type ExtraChargeType = (typeof EXTRA_CHARGE_TYPES)[number];

export const EXTRA_CHARGE_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

/** Booking references look like RV-7K2Q9M. */
export const BOOKING_REF_PATTERN = /^RV-[A-Z0-9]{6}$/;

/** A copy of the protection plan as it was when booked. */
export interface BookedProtectionPlan {
  code: string;
  name: string;
  priceCents: number;
  excessCents: number;
  coverSummary: string;
  mandatory: boolean;
}

export interface VehicleSnapshot {
  title: string;
  photoUrl?: string;
  regoPlate?: string;
}

/** The listing terms copied when booked, so later changes don't apply to this trip (plan §3, Key rules). */
export interface BookedTerms {
  fuelPolicy: FuelPolicy;
  kmAllowancePerDay?: number;
  unlimitedKm: boolean;
  extraKmCents: number;
}

export interface BookingPrice {
  subtotalCents: number;
  deliveryCents: number;
  serviceFeeCents: number;
  protectionCents: number;
  gstCents: number;
  totalCents: number;
  hostPayoutCents: number;
  platformFeeCents: number;
}

/** One line of the price breakdown, with its own GST (plan §5). A discount line is negative. */
export interface LineItem {
  code: string;
  label: string;
  amountCents: number;
  gstCents: number;
  mandatory: boolean;
}

/** Every status change, including admin edits, with who made it and why. */
export interface StatusChange {
  status: BookingStatus;
  at: Date;
  by?: Types.ObjectId;
  reason?: string;
}

export interface ExtraCharge {
  _id?: Types.ObjectId;
  type: ExtraChargeType;
  description: string;
  amountCents: number;
  incidentId?: Types.ObjectId;
  addedBy?: Types.ObjectId;
  paymentId?: Types.ObjectId;
  status: (typeof EXTRA_CHARGE_STATUSES)[number];
}

/** The `bookings` collection (plan §3). */
export interface Booking {
  ref: string;
  vehicleId: Types.ObjectId;
  guestId: Types.ObjectId;
  hostId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  pickupOptionId?: Types.ObjectId;
  pickupAddress?: NzAddress;
  returnOptionId?: Types.ObjectId;
  returnAddress?: NzAddress;
  protectionPlan?: BookedProtectionPlan;
  status: BookingStatus;
  requestExpiresAt?: Date;
  vehicleSnapshot: VehicleSnapshot;
  terms: BookedTerms;
  price: BookingPrice;
  /** The cancellation tier code, copied from the listing. */
  cancellationPolicy?: string;
  cancelledBy?: Types.ObjectId;
  cancelledAt?: Date;
  cancellationReason?: CancellationReason;
  cancellationFeeCents?: number;
  lineItems: LineItem[];
  statusHistory: StatusChange[];
  extraCharges: ExtraCharge[];
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema<LineItem>(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    amountCents: signedCents({ required: true }),
    gstCents: signedCents({ required: true }),
    mandatory: { type: Boolean, required: true },
  },
  { _id: false },
);

const statusChangeSchema = new Schema<StatusChange>(
  {
    status: { type: String, enum: BOOKING_STATUSES, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: String,
  },
  { _id: false },
);

const extraChargeSchema = new Schema<ExtraCharge>({
  type: { type: String, enum: EXTRA_CHARGE_TYPES, required: true },
  description: { type: String, required: true },
  amountCents: { ...cents({ required: true }), min: 1 },
  incidentId: { type: Schema.Types.ObjectId, ref: 'Incident' },
  addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
  status: { type: String, enum: EXTRA_CHARGE_STATUSES, default: 'PENDING' },
});

const bookingSchema = new Schema<Booking>(
  {
    ref: {
      type: String,
      required: true,
      unique: true,
      match: [BOOKING_REF_PATTERN, 'ref looks like RV-XXXXXX'],
    },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    guestId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    hostId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startAt: { type: Date, required: true },
    endAt: {
      type: Date,
      required: true,
      validate: {
        validator(this: Booking, endAt: Date) {
          return !this.startAt || endAt > this.startAt;
        },
        message: 'endAt must be after startAt',
      },
    },
    pickupOptionId: Schema.Types.ObjectId,
    pickupAddress: { type: nzAddressSchema },
    returnOptionId: Schema.Types.ObjectId,
    returnAddress: { type: nzAddressSchema },
    protectionPlan: {
      type: new Schema<BookedProtectionPlan>(
        {
          code: { type: String, required: true },
          name: { type: String, required: true },
          priceCents: cents({ required: true }),
          excessCents: cents({ required: true }),
          coverSummary: { type: String, required: true },
          mandatory: { type: Boolean, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    status: { type: String, enum: BOOKING_STATUSES, default: 'PAYMENT_PENDING' },
    requestExpiresAt: Date,
    vehicleSnapshot: {
      type: new Schema<VehicleSnapshot>(
        { title: { type: String, required: true }, photoUrl: String, regoPlate: String },
        { _id: false },
      ),
      required: true,
    },
    terms: {
      type: new Schema<BookedTerms>(
        {
          fuelPolicy: { type: String, enum: FUEL_POLICIES, required: true },
          kmAllowancePerDay: { type: Number, min: 0 },
          unlimitedKm: { type: Boolean, required: true },
          extraKmCents: cents({ required: true }),
        },
        { _id: false },
      ),
      required: true,
    },
    price: {
      type: new Schema<BookingPrice>(
        {
          subtotalCents: cents({ required: true }),
          deliveryCents: cents({ required: true }),
          serviceFeeCents: cents({ required: true }),
          protectionCents: cents({ required: true }),
          gstCents: cents({ required: true }),
          totalCents: cents({ required: true }),
          hostPayoutCents: cents({ required: true }),
          platformFeeCents: cents({ required: true }),
        },
        { _id: false },
      ),
      required: true,
    },
    cancellationPolicy: String,
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: Date,
    cancellationReason: { type: String, enum: CANCELLATION_REASONS },
    cancellationFeeCents: cents(),
    lineItems: { type: [lineItemSchema], default: [] },
    statusHistory: { type: [statusChangeSchema], default: [] },
    extraCharges: { type: [extraChargeSchema], default: [] },
  },
  { timestamps: true },
);

bookingSchema.index({ guestId: 1, startAt: -1 });
bookingSchema.index({ hostId: 1, status: 1, startAt: -1 });
// A car's upcoming bookings, for deactivation and suspension.
bookingSchema.index({ vehicleId: 1, status: 1, startAt: 1 });

export const BookingModel = model<Booking>('Booking', bookingSchema);
export type BookingDocument = HydratedDocument<Booking>;
