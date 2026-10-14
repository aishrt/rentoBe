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

/**
 * A listing photo's placeholder width: enough for its colours and shapes once the website blurs it, in a
 * few hundred bytes.
 */
const PLACEHOLDER_WIDTH = 20;

/** A member's profile photo: shown at most 80 px across (the member page), so one copy is enough. */
export const PROFILE_PHOTO_WIDTHS = [400] as const;

/**
 * A message photo's smaller copy, which the conversation shows (at most 256 px across); tapping it opens
 * the photo itself.
 */
export const MESSAGE_PREVIEW_WIDTH = 800;

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

/**
 * The WebP copies of a public photo, one for each width (a listing photo's PHOTO_WIDTHS unless given).
 * Smaller photos aren't enlarged.
 */
export async function photoVariants(
  buffer: Buffer,
  widths: readonly number[] = PHOTO_WIDTHS,
): Promise<{ width: number; body: Buffer }[]> {
  try {
    const open = await opener(buffer);
    return await Promise.all(
      widths.map(async (width) => ({
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

/**
 * A tiny copy of a listing photo, which the website shows blurred while the photo loads (plan §12.5): a
 * WebP data URI of a few hundred bytes, small enough to send with the listing and its card.
 */
export async function photoPlaceholder(buffer: Buffer): Promise<string> {
  try {
    const open = await opener(buffer);
    const body = await open()
      .resize({ width: PLACEHOLDER_WIDTH, height: PLACEHOLDER_WIDTH, fit: 'inside' })
      .webp({ quality: 50 })
      .toBuffer();
    return `data:image/webp;base64,${body.toString('base64')}`;
  } catch {
    throw unreadable();
  }
}

/**
 * A private photo the other party sees (a message photo): an upright JPEG with no metadata, which can say
 * where it was taken (plan §6.2), and a smaller WebP copy `previewWidth` across to show in a conversation.
 */
export async function sharedPhoto(
  buffer: Buffer,
  previewWidth: number,
): Promise<{ photo: Buffer; preview: Buffer }> {
  try {
    const open = await opener(buffer);
    const [photo, preview] = await Promise.all([
      open()
        .resize({ width: DOCUMENT_MAX_PX, height: DOCUMENT_MAX_PX, fit: 'inside', withoutEnlargement: true })
        // A screenshot's see-through parts show white, not black.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer(),
      open()
        .resize({ width: previewWidth, height: previewWidth, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer(),
    ]);
    return { photo, preview };
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
