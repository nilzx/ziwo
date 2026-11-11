// Time zones. Everything stored is an absolute instant in unix milliseconds;
// a zone is only used to read a wall-clock time a model wrote and to show an
// instant to the session that asked. The runtime's Intl data is the only
// source of zone rules.

export const UTC = "UTC";

const day = 24 * 60 * 60 * 1000;

// One formatter per zone: building one is the expensive part.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
    formatters.set(zone, f);
  }
  return f;
}

// knownZone returns the runtime's name for zone, or undefined when the
// runtime does not know it. Only names are taken: an offset such as +08:00
// is not a zone, and would not follow daylight saving.
export function knownZone(zone: string): string | undefined {
  if (!/^[A-Za-z]/.test(zone)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// Wall is a wall-clock reading: what a clock in some zone shows.
export interface Wall {
  year: number;
  month: number; // 1 to 12
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

// wallAt reads the wall clock of zone at instant t.
export function wallAt(t: number, zone: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(t))) parts[p.type] = p.value;
  let year = Number(parts.year);
  if (parts.era === "BC") year = 1 - year;
  return {
    year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    ms: ((t % 1000) + 1000) % 1000,
  };
}

// asUTC is the instant at which a UTC clock shows w. Date.UTC would read
// years below 100 as 19xx.
export function asUTC(w: Wall): number {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, w.ms);
  return d.getTime();
}

// offsetAt is how far zone's wall clock is ahead of UTC at instant t, in
// milliseconds.
export function offsetAt(t: number, zone: string): number {
  return asUTC(wallAt(t, zone)) - t;
}

// instantOf returns the instant at which zone's wall clock shows w. Across
// a daylight-saving change it reads as Temporal's "compatible" choice does:
// a time that occurs twice is the earlier one, and a time skipped over is
// moved forward by the length of the gap.
export function instantOf(w: Wall, zone: string): number {
  const wall = asUTC(w);
  // The offsets on either side of any change near this time.
  const before = offsetAt(wall - day, zone);
  const after = offsetAt(wall + day, zone);
  const fits = [wall - before, wall - after].filter((t) => offsetAt(t, zone) === wall - t);
  if (fits.length > 0) return Math.min(...fits);
  return wall - before;
}

function pad(n: number, width: number): string {
  const s = String(Math.abs(n)).padStart(width, "0");
  return n < 0 ? "-" + s : s;
}

// formatDate is the date in zone at instant t, as Go's time.DateOnly.
export function formatDate(t: number, zone: string): string {
  const w = wallAt(t, zone);
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;
}

// formatDateTime is the date and time in zone at instant t: Go's
// "2006-01-02 15:04Z" for an instant at which the zone is on UTC, and the
// offset after a space otherwise, such as 2026-11-11 20:15 +08:00.
export function formatDateTime(t: number, zone: string): string {
  const w = wallAt(t, zone);
  const base = `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)} ${pad(w.hour, 2)}:${pad(w.minute, 2)}`;
  // Seconds of an offset (old local mean times) are dropped, as Go drops them.
  const off = Math.trunc(offsetAt(t, zone) / 60000);
  if (off === 0) return base + "Z";
  const a = Math.abs(off);
  return `${base} ${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60), 2)}:${pad(a % 60, 2)}`;
}
