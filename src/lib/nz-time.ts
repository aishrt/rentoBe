export const NZ_TIME_ZONE = 'Pacific/Auckland';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

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
 * The instant NZ clocks show a wall-clock time. Correct across daylight saving changes: a time in the
 * hour skipped in September lands just after the change, and one in the hour repeated in April takes
 * the first of the two.
 */
export function fromNzWallClock(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The offset depends on the instant, so guess with the offset at the wall-clock time, then correct.
  const guess = wallClockAsUtc - nzOffsetMinutes(new Date(wallClockAsUtc)) * MINUTE_MS;
  return new Date(wallClockAsUtc - nzOffsetMinutes(new Date(guess)) * MINUTE_MS);
}

export interface NzWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday, as in recurring availability rules. */
  weekday: number;
}

/** What NZ clocks and calendars show at an instant. */
export function toNzWallClock(instant: Date): NzWallClock {
  const shifted = new Date(instant.getTime() + nzOffsetMinutes(instant) * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Midnight at the start of the NZ day an instant falls in. */
export function startOfNzDay(instant: Date): Date {
  const { year, month, day } = toNzWallClock(instant);
  return fromNzWallClock(year, month, day);
}

/** The same NZ wall-clock time `days` later, whatever the daylight saving changes in between. */
export function addNzDays(instant: Date, days: number): Date {
  const { year, month, day, hour, minute } = toNzWallClock(instant);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return fromNzWallClock(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute);
}

const NZ_LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A date and time from the website or an app: "2026-10-12T10:00" is NZ time (plan §3: times are shown
 * and entered in NZ time), and a full ISO 8601 time with Z or an offset is taken as it is. Null when
 * it isn't a real time.
 */
export function parseNzDateTime(value: string): Date | null {
  const local = NZ_LOCAL_DATE_TIME.exec(value);
  if (local) {
    const [year, month, day, hour, minute] = local.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1) return null;
    return fromNzWallClock(year, month, day, hour, minute);
  }
  if (!WITH_OFFSET.test(value)) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** "2026-10-12T10:00", the NZ wall-clock form the website puts in URLs. */
export function toNzLocalDateTime(instant: Date): string {
  const { year, month, day, hour, minute } = toNzWallClock(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/**
 * Trip days for pricing (plan §5): counted on NZ wall-clock time, so 10 am to 10 am is one day even
 * when a daylight saving change makes it 23 or 25 hours long, and any other part day counts as a
 * full day. At least 1.
 */
export function nzTripDays(startAt: Date, endAt: Date): number {
  const wall = (instant: Date) => instant.getTime() + nzOffsetMinutes(instant) * MINUTE_MS;
  return Math.max(1, Math.ceil((wall(endAt) - wall(startAt)) / DAY_MS));
}

/**
 * The next time after `from` that NZ clocks show `hour`:00, for daily jobs (plan §4.3). Correct
 * across daylight saving changes, which happen at 2–3 am.
 */
export function nextNzHour(from: Date, hour: number): Date {
  for (let days = 0; days <= 2; days += 1) {
    const [year, month, day] = nzDate(new Date(from.getTime() + days * DAY_MS))
      .split('-')
      .map(Number);
    const candidate = fromNzWallClock(year!, month!, day!, hour);
    if (candidate > from) return candidate;
  }
  throw new Error(`No ${hour}:00 in NZ found after ${from.toISOString()}`);
}
