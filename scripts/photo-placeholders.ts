/**
 * Gives listing photos uploaded before 14/10/2026 their blurred placeholder (plan §12.5), made from each
 * photo's 800 px copy in storage, as new uploads get one. Photos that have one already, and images storage
 * didn't make (the demo cars'), are left alone, so it's safe to re-run.
 *
 *   npm run photos:placeholders
 *
 * On AWS it runs once from the built image as a one-off task, which can read the media bucket:
 * node dist/photo-placeholders.js (DEPLOYING_UPDATES.md, section 9).
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { listingPhotoPlaceholder } from '../src/integrations/storage/storage.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';

async function addPlaceholders() {
  const connection = await connectDb();
  console.log(`Database: ${connection.connection.name}`);
  const counts = { added: 0, notOurs: 0, failed: 0 };

  for await (const vehicle of VehicleModel.find().select('slug photos').lean().cursor()) {
    for (const photo of vehicle.photos ?? []) {
      if (photo.placeholder || !photo._id) continue;
      try {
        const placeholder = await listingPhotoPlaceholder(photo.url);
        if (!placeholder) {
          counts.notOurs += 1;
          continue;
        }
        // By the photo's id, so one removed meanwhile is left alone. The car itself hasn't changed.
        await VehicleModel.updateOne(
          { _id: vehicle._id, 'photos._id': photo._id },
          { $set: { 'photos.$.placeholder': placeholder } },
          { timestamps: false },
        );
        counts.added += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`  ${vehicle.slug} ${photo.url}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  console.log(
    `Placeholders added: ${counts.added}. Not from our storage, left alone: ${counts.notOurs}. ` +
      `Failed: ${counts.failed}.`,
  );
  if (counts.failed > 0) process.exitCode = 1;
}

addPlaceholders()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
