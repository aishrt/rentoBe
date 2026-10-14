import { afterEach, describe, expect, it, vi } from 'vitest';
import { forget, memo } from '../src/lib/memo.js';

describe('memo', () => {
  afterEach(() => forget());

  it("keeps a value until it expires, and doesn't keep a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('up');
    await expect(memo('key', 60_000, load)).rejects.toThrow('down');
    expect(await memo('key', 60_000, load)).toBe('up');
    expect(await memo('key', 60_000, load)).toBe('up');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets the oldest values go once it holds a thousand', async () => {
    const load = vi.fn(async () => 'value');
    for (let index = 0; index <= 1_000; index += 1) await memo(`address:${index}`, 60_000, load);
    expect(load).toHaveBeenCalledTimes(1_001);

    await memo('address:1000', 60_000, load);
    expect(load).toHaveBeenCalledTimes(1_001);
    await memo('address:0', 60_000, load);
    expect(load).toHaveBeenCalledTimes(1_002);
  });
});
