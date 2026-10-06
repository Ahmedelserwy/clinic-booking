/** Formats a Date as a timezone-safe `YYYY-MM-DD` string (date only). */
export function toDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Combines a Date and an `HH:mm` time string into a local ISO date-time string. */
export function combineDateAndTime(date: Date, time: string): string {
  const [hours = '0', minutes = '0'] = time.split(':');
  const result = new Date(date);
  result.setHours(Number(hours), Number(minutes), 0, 0);
  return toLocalIso(result);
}

/** ISO 8601 with the browser's local offset, preserving the wall-clock time the user picked. */
export function toLocalIso(date: Date): string {
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
  );
}

/** Safely parses an ISO string into a Date, or null when invalid. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

// -----------------------------------------------------------------------------
// Time of day
//
// The API models working hours as a .NET TimeSpan, serialised as `"09:00:00"`.
// The UI must never show that: this application displays 12-hour time and
// nothing else, so every boundary converts here rather than in a component.
// -----------------------------------------------------------------------------

/** Minutes since midnight from `"HH:mm"` / `"HH:mm:ss"`. */
export function timeToMinutes(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** `"HH:mm:ss"` — the shape the API expects back. */
export function minutesToTimeSpan(minutes: number): string {
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

/** A Date carrying only the given time — the value `mat-timepicker` binds to. */
export function minutesToDate(minutes: number, base: Date = new Date()): Date {
  const date = new Date(base);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

export function dateToMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * 12-hour display, e.g. `9:00 AM` / `2:15 PM`.
 *
 * Accepts minutes, a Date, or a TimeSpan string, because working hours arrive
 * in all three shapes depending on whether they came from a picker, the API or
 * a computed slot.
 */
export function formatTime12(value: number | Date | string): string {
  const minutes =
    typeof value === 'number'
      ? value
      : value instanceof Date
        ? dateToMinutes(value)
        : timeToMinutes(value);

  const hours24 = Math.floor(minutes / 60) % 24;
  const mins = Math.round(minutes % 60);
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;

  return `${hours12}:${`${mins}`.padStart(2, '0')} ${suffix}`;
}

/** `9:00 AM – 5:00 PM`, using an en dash as the range separator. */
export function formatTimeRange(
  start: number | Date | string,
  end: number | Date | string
): string {
  return `${formatTime12(start)} – ${formatTime12(end)}`;
}

// -----------------------------------------------------------------------------
// Calendar helpers
// -----------------------------------------------------------------------------

export function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isToday(value: Date | string): boolean {
  const date = value instanceof Date ? value : parseDate(value);
  return date ? isSameDay(date, new Date()) : false;
}

/** Inclusive list of days between two dates — used by report period pickers. */
export function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  let cursor = startOfDay(from);
  const last = startOfDay(to);

  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }

  return days;
}
