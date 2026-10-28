import { config } from './config';

/** Add days to a YYYY-MM-DD date and return YYYY-MM-DD. Uses UTC so daylight saving never matters. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Today's date for the businesses, as YYYY-MM-DD: the date in APP_TIME_ZONE (default Asia/Manila),
 * whatever time zone the server's own clock is set to.
 */
export function localToday(now: Date = new Date(), timeZone: string = config.timeZone): string {
  const part = partsIn(now, timeZone);
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The time of day in APP_TIME_ZONE as HHMMSS (24-hour), for file names. */
export function localTimeStamp(now: Date = new Date(), timeZone: string = config.timeZone): string {
  const part = partsIn(now, timeZone);
  return `${part('hour')}${part('minute')}${part('second')}`;
}

// One formatter per time zone: localToday runs on every signed-in request.
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(now: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(now);
  return (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
}
