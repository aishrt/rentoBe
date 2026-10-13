import { PROFILE_PHOTO_WIDTHS } from '../../integrations/storage/images.js';
import { logger } from '../../integrations/logger.js';
import { getStorage } from '../../integrations/storage/storage.js';
import { unauthenticated } from '../../lib/http-error.js';
import { profilePhotoFolder } from '../uploads/upload-folders.js';
import { UserModel } from './user.model.js';
import { toPublicUser, type PublicUser } from './user.service.js';

/*
 * A member's profile photo (spec §8 personal details; plan §6.2: a Host sees a Guest's first name and
 * photo, and a Guest the Host's). It's uploaded with POST /uploads/signature (PROFILE_PHOTO) into the
 * member's own public folder, stored like a listing photo (upright WebP without its metadata, which can hold
 * where it was taken), and shown wherever the member is: booking views, messages and their public profile.
 */

/**
 * Deletes a stored profile photo that's been replaced, removed or anonymised. Already cleared from the
 * account, so a storage problem is logged rather than undoing that.
 */
export async function deleteProfilePhotoFile(url: string): Promise<void> {
  try {
    await getStorage().deletePublic({ url, widths: PROFILE_PHOTO_WIDTHS });
  } catch (error) {
    logger.warn({ err: error }, 'Could not delete a profile photo');
  }
}

/**
 * PUT /me/photo: makes the photo just uploaded the member's profile photo. The key must be in their own
 * PROFILE_PHOTO folder, so nobody can set a photo someone else uploaded. The photo it replaces is deleted.
 */
export async function setProfilePhoto(userId: string, key: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId).select('status').lean();
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  const url = await getStorage().confirmUpload({
    ...profilePhotoFolder(userId),
    ref: key,
    widths: PROFILE_PHOTO_WIDTHS,
  });

  const before = await UserModel.findOneAndUpdate(
    { _id: user._id, status: 'ACTIVE' },
    { $set: { avatarUrl: url } },
    { new: false },
  );
  if (!before) {
    // Suspended or closed meanwhile: the photo isn't kept.
    await deleteProfilePhotoFile(url);
    throw unauthenticated();
  }
  if (before.avatarUrl && before.avatarUrl !== url) await deleteProfilePhotoFile(before.avatarUrl);
  before.avatarUrl = url;
  return toPublicUser(before);
}

/** DELETE /me/photo: removes the profile photo, so the member shows as their initials again. */
export async function removeProfilePhoto(userId: string): Promise<PublicUser> {
  const before = await UserModel.findOneAndUpdate(
    { _id: userId, status: 'ACTIVE' },
    { $unset: { avatarUrl: 1 } },
    { new: false },
  );
  if (!before) throw unauthenticated();
  if (before.avatarUrl) await deleteProfilePhotoFile(before.avatarUrl);
  before.avatarUrl = undefined;
  return toPublicUser(before);
}
