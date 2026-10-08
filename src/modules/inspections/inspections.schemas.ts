import { z } from 'zod';
import { INSPECTION_ANGLES, INSPECTION_STAGES } from './condition-report.model.js';

/* The digital vehicle handover (spec §14, plan §9 Days 19–21): check-in and check-out reports. */

const percent = z.number().min(0).max(100);

export const inspectionPhotoInputSchema = z
  .object({
    angle: z.enum(INSPECTION_ANGLES),
    key: z.string().min(1).max(300).meta({ description: 'From POST /uploads/signature (INSPECTION_PHOTO)' }),
    takenAt: z.iso.datetime({ offset: true }).meta({ description: 'The device clock when it was taken' }),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .meta({ id: 'InspectionPhotoInput' });

export const damagePinInputSchema = z
  .object({
    x: percent.meta({ description: 'Across the car diagram, 0–100 %' }),
    y: percent.meta({ description: 'Down the car diagram, 0–100 %' }),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'DamagePinInput' });

export const inspectionInputSchema = z
  .object({
    stage: z.enum(INSPECTION_STAGES),
    odometer: z
      .number({ error: 'Enter the odometer reading' })
      .int({ error: 'Odometer readings are whole kilometres' })
      .min(0)
      .max(2_000_000),
    fuelOrBatteryPct: percent.meta({ description: 'Fuel, or battery charge for an EV, 0–100 %' }),
    notes: z.string().trim().max(2000).optional(),
    photos: z.array(inspectionPhotoInputSchema).min(1).max(40),
    damagePins: z
      .array(damagePinInputSchema)
      .max(30)
      .default([])
      .meta({ description: 'Check-in: damage already on the car. Check-out: new damage.' }),
  })
  .meta({ id: 'InspectionRequest' });
export type InspectionInput = z.infer<typeof inspectionInputSchema>;

export const flagDamageSchema = z
  .object({
    damagePins: z.array(damagePinInputSchema).min(1, { error: 'Mark where the damage is' }).max(10),
    photos: z.array(inspectionPhotoInputSchema).max(10).default([]),
    note: z.string().trim().max(2000).optional(),
  })
  .meta({ id: 'FlagDamageRequest' });
export type FlagDamageInput = z.infer<typeof flagDamageSchema>;

const party = z.enum(['GUEST', 'HOST', 'STAFF']);

export const conditionReportSchema = z
  .object({
    stage: z.enum(INSPECTION_STAGES),
    odometer: z.number().int(),
    fuelOrBatteryPct: z.number(),
    notes: z.string().optional(),
    submittedBy: party,
    submittedAt: z.iso.datetime(),
    photos: z.array(
      z.object({
        angle: z.enum(INSPECTION_ANGLES),
        url: z.string().meta({ description: 'A private link that works for 10 minutes' }),
        takenBy: party,
        takenAt: z.iso.datetime(),
        uploadedAt: z.iso.datetime(),
      }),
    ),
    damagePins: z.array(
      z.object({
        id: z.string(),
        x: z.number(),
        y: z.number(),
        note: z.string().optional(),
        newDamage: z.boolean(),
        flaggedBy: party.optional(),
        flaggedAt: z.iso.datetime().optional(),
      }),
    ),
    confirmedByGuestAt: z.iso.datetime().optional(),
    confirmedByHostAt: z.iso.datetime().optional(),
    completedBySupport: z.boolean(),
  })
  .meta({ id: 'ConditionReport' });
export type ConditionReportView = z.infer<typeof conditionReportSchema>;

export const handoverSchema = z
  .object({
    ref: z.string(),
    role: party,
    bookingStatus: z.string(),
    energy: z.enum(['FUEL', 'BATTERY']).meta({ description: 'BATTERY for an EV: readings are charge %' }),
    fuelPolicy: z.enum(['SAME_LEVEL', 'FULL']),
    requiredAngles: z.array(z.enum(INSPECTION_ANGLES)),
    checkInOpensAt: z.iso.datetime().meta({ description: 'Check-in opens 2 hours before the start' }),
    checkIn: conditionReportSchema.nullable(),
    checkOut: conditionReportSchema.nullable(),
    damageWindowEndsAt: z.iso.datetime().optional().meta({
      description: 'After check-out: new damage can be flagged until then',
    }),
    emailVerificationNeeded: z.boolean().meta({
      description: 'The Guest must confirm their email address before check-in (plan §6.1)',
    }),
    kilometres: z
      .object({
        driven: z.number().int(),
        allowance: z.number().int().nullable().meta({ description: 'null: unlimited kilometres' }),
        extra: z.number().int(),
        extraChargeCents: z.number().int(),
      })
      .optional()
      .meta({ description: 'After check-out' }),
    fuelShortfall: z
      .boolean()
      .meta({ description: 'Returned with less fuel or charge than the policy asks' }),
    actions: z.object({
      checkIn: z.boolean(),
      checkOut: z.boolean(),
      confirmCheckIn: z.boolean(),
      confirmCheckOut: z.boolean(),
      flagDamage: z.boolean(),
    }),
  })
  .meta({ id: 'Handover' });
export type HandoverView = z.infer<typeof handoverSchema>;

export const handoverResponseSchema = z.object({ handover: handoverSchema }).meta({ id: 'HandoverResponse' });
