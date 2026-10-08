import { z } from 'zod';

/**
 * What an upload is for; each has its own folder and allowed file types (plan §3, content and files).
 * Vehicle files belong to a car; message photos, inspection photos and incident evidence to a booking.
 */
export const UPLOAD_PURPOSES = [
  'VEHICLE_PHOTO',
  'VEHICLE_DOCUMENT',
  'MESSAGE_PHOTO',
  'INSPECTION_PHOTO',
  'INCIDENT_FILE',
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** The purposes whose files belong to a booking rather than a car. */
export const BOOKING_UPLOAD_PURPOSES = ['MESSAGE_PHOTO', 'INSPECTION_PHOTO', 'INCIDENT_FILE'] as const;
export type BookingUploadPurpose = (typeof BOOKING_UPLOAD_PURPOSES)[number];

export const PHOTO_TYPES_ALLOWED = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export const DOCUMENT_TYPES_ALLOWED = [...PHOTO_TYPES_ALLOWED, 'application/pdf'] as const;

const objectId = z.string().regex(/^[0-9a-f]{24}$/, { error: 'Unknown car' });

export const uploadRequestSchema = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    vehicleId: objectId.optional().meta({ description: 'For VEHICLE_PHOTO and VEHICLE_DOCUMENT' }),
    bookingId: z
      .string()
      .regex(/^([0-9a-f]{24}|RV-[A-Za-z0-9]{6})$/, { error: 'Unknown booking' })
      .optional()
      .meta({ description: 'For MESSAGE_PHOTO, INSPECTION_PHOTO and INCIDENT_FILE: its id or reference' }),
    contentType: z.string().max(100),
    size: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024, { error: 'Files can be up to 15 MB' }),
  })
  .superRefine((input, context) => {
    const forBooking = (BOOKING_UPLOAD_PURPOSES as readonly string[]).includes(input.purpose);
    if (forBooking && !input.bookingId) {
      context.addIssue({ code: 'custom', path: ['bookingId'], message: 'Choose the booking' });
    }
    if (!forBooking && !input.vehicleId) {
      context.addIssue({ code: 'custom', path: ['vehicleId'], message: 'Unknown car' });
    }
  })
  .meta({ id: 'UploadRequest' });
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export const uploadTargetSchema = z
  .object({
    driver: z.enum(['local', 's3']),
    method: z.enum(['PUT', 'POST']),
    url: z.string(),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .meta({ description: 'PUT: send the file as the body with these' }),
    fields: z
      .record(z.string(), z.string())
      .optional()
      .meta({ description: 'POST: a multipart form with these fields, then the file as `file`' }),
    key: z.string().meta({ description: 'Attach the file to the car or booking with this once it is sent' }),
    maxBytes: z.number().int(),
  })
  .meta({
    id: 'UploadTarget',
    description:
      'Where to send one file: the API itself in development (`local`), or the S3 bucket (`s3`, a presigned POST with no cookies).',
  });

/** A file sent with a message, an inspection or an incident: the upload's key, and how to show it. */
export const attachmentInputSchema = z
  .object({
    key: z.string().min(1).max(300),
    name: z.string().trim().max(200).optional(),
    contentType: z.string().max(100).optional(),
  })
  .meta({ id: 'AttachmentInput' });
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

/** A private file as the people allowed to see it get it: a link that works for 10 minutes. */
export const attachmentViewSchema = z
  .object({
    url: z.string(),
    name: z.string().optional(),
    contentType: z.string().optional(),
  })
  .meta({ id: 'Attachment' });
export type AttachmentView = z.infer<typeof attachmentViewSchema>;
