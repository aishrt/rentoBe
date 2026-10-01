import decodeHeic from 'heic-decode';
import sharp, { type Sharp } from 'sharp';
import { HttpError } from '../../lib/http-error.js';

/*
 * Image work for uploads kept in S3 (plan §3 "Public and private files", §12.5 speed budget). A listing
 * photo is stored as WebP in the widths the website shows, upright, and without its metadata, which can
 * hold the place it was taken. HEIC photos from iPhones are decoded here: only Safari can show them, and
 * sharp's standard build can't read them.
 */

/** Listing photo widths: cards and phones use the smaller one, the gallery the larger. */
export const PHOTO_WIDTHS = [800, 1600] as const;

/** Documents stay sharp enough to read the small print, but no larger. */
const DOCUMENT_MAX_PX = 4000;

const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']);

/** Whether the file is HEIC or HEIF, from its contents (Windows often sends HEIC without a type). */
export function isHeif(buffer: Buffer): boolean {
  return (
    buffer.length > 12 &&
    buffer.toString('latin1', 4, 8) === 'ftyp' &&
    HEIF_BRANDS.has(buffer.toString('latin1', 8, 12))
  );
}

const unreadable = () =>
  new HttpError(
    400,
    'UNREADABLE_IMAGE',
    "We couldn't read that photo. Please try another one, or save it as a JPEG first.",
  );

/** Opens the image the right way up. Each call is a new pipeline, so the sizes don't share state. */
async function opener(buffer: Buffer): Promise<() => Sharp> {
  if (isHeif(buffer)) {
    // libheif applies the photo's rotation itself, so the pixels come out upright.
    const { width, height, data } = await decodeHeic({ buffer });
    const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return () => sharp(pixels, { raw: { width, height, channels: 4 } }).removeAlpha();
  }
  return () => sharp(buffer, { failOn: 'error' }).autoOrient();
}

/** The WebP copies of a listing photo, one for each of PHOTO_WIDTHS. Smaller photos aren't enlarged. */
export async function photoVariants(buffer: Buffer): Promise<{ width: number; body: Buffer }[]> {
  try {
    const open = await opener(buffer);
    return await Promise.all(
      PHOTO_WIDTHS.map(async (width) => ({
        width,
        body: await open()
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer(),
      })),
    );
  } catch {
    throw unreadable();
  }
}

/** A HEIC document photo as a JPEG, so support staff can open it in any browser. */
export async function documentAsJpeg(buffer: Buffer): Promise<Buffer> {
  try {
    const open = await opener(buffer);
    return await open()
      .resize({ width: DOCUMENT_MAX_PX, height: DOCUMENT_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    throw unreadable();
  }
}
