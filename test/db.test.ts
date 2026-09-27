import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db.js';

// Stand-ins for the vehicles and availabilityBlocks collections of plan §3.
const CarModel = mongoose.model('TxTestCar', new Schema({ bookingSeq: { type: Number, default: 0 } }));
const BlockModel = mongoose.model(
  'TxTestBlock',
  new Schema({ carId: { type: Schema.Types.ObjectId, required: true }, day: Number }),
);

/** The double-booking check from plan §3, in miniature. */
function bookDay(carId: mongoose.Types.ObjectId, day: number) {
  return withTransaction(async (session) => {
    // Writing the car first makes simultaneous bookings for it conflict, so MongoDB retries all but one.
    await CarModel.updateOne({ _id: carId }, { $inc: { bookingSeq: 1 } }, { session });
    if (await BlockModel.exists({ carId, day }).session(session)) throw new Error('Vehicle not available');
    const [block] = await BlockModel.create([{ carId, day }], { session });
    return block!.id as string;
  });
}

describe('withTransaction', () => {
  it('commits every write and returns the result', async () => {
    const car = await CarModel.create({});
    const blockId = await bookDay(car._id, 1);

    expect(await BlockModel.findById(blockId)).not.toBeNull();
    expect((await CarModel.findById(car._id))?.bookingSeq).toBe(1);
  });

  it('rolls back every write when the work throws', async () => {
    const car = await CarModel.create({});
    await expect(
      withTransaction(async (session) => {
        await CarModel.updateOne({ _id: car._id }, { $inc: { bookingSeq: 1 } }, { session });
        await BlockModel.create([{ carId: car._id, day: 1 }], { session });
        throw new Error('Payment failed');
      }),
    ).rejects.toThrow('Payment failed');

    expect(await BlockModel.countDocuments()).toBe(0);
    expect((await CarModel.findById(car._id))?.bookingSeq).toBe(0);
  });

  it('lets exactly one of 20 simultaneous bookings for the same day through', async () => {
    const car = await CarModel.create({});
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => bookDay(car._id, 1)));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused.every((result) => String(result.reason).includes('Vehicle not available'))).toBe(true);
    expect(await BlockModel.countDocuments({ carId: car._id, day: 1 })).toBe(1);
  });
});
