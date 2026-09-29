const NZ_TIME_ZONE = 'Pacific/Auckland';

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: NZ_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: NZ_TIME_ZONE, timeZoneName: 'longOffset' });

/** The date on NZ calendars at an instant, as YYYY-MM-DD. */
export function nzDate(instant: Date): string {
  return dateFormat.format(instant);
}

/** How many minutes NZ is ahead of UTC at an instant: 720, or 780 in daylight saving time. */
function nzOffsetMinutes(instant: Date): number {
  const name = offsetFormat.formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
  if (!match) throw new Error(`Unexpected time zone offset "${name}"`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * The next time after `from` that NZ clocks show `hour`:00, for daily jobs (plan §4.3). Correct
 * across daylight saving changes, which happen at 2–3 am.
 */
export function nextNzHour(from: Date, hour: number): Date {
  for (let days = 0; days <= 2; days += 1) {
    const [year, month, day] = nzDate(new Date(from.getTime() + days * 86_400_000))
      .split('-')
      .map(Number);
    const wallClockAsUtc = Date.UTC(year!, month! - 1, day!, hour);
    // The offset depends on the instant, so guess with the offset at the wall-clock time, then correct.
    const guess = wallClockAsUtc - nzOffsetMinutes(new Date(wallClockAsUtc)) * 60_000;
    const candidate = wallClockAsUtc - nzOffsetMinutes(new Date(guess)) * 60_000;
    if (candidate > from.getTime()) return new Date(candidate);
  }
  throw new Error(`No ${hour}:00 in NZ found after ${from.toISOString()}`);
}
