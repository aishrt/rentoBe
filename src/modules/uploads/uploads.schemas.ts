import { z } from 'zod';

/** What an upload is for; each has its own folder and allowed file types (plan §3, content and files). */
export const UPLOAD_PURPOSES = ['VEHICLE_PHOTO', 'VEHICLE_DOCUMENT'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export const PHOTO_TYPES_ALLOWED = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export const DOCUMENT_TYPES_ALLOWED = [...PHOTO_TYPES_ALLOWED, 'application/pdf'] as const;

export const uploadRequestSchema = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    vehicleId: z.string().regex(/^[0-9a-f]{24}$/, { error: 'Unknown car' }),
    contentType: z.string().max(100),
    size: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024, { error: 'Files can be up to 15 MB' }),
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
    key: z.string().meta({ description: 'Attach the file to the car with this once it is sent' }),
    maxBytes: z.number().int(),
  })
  .meta({
    id: 'UploadTarget',
    description:
      'Where to send one file: the API itself in development (`local`), or the S3 bucket (`s3`, a presigned POST with no cookies).',
  });
