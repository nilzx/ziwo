// A memory's settings: its forgetting parameters and its default time zone.
// One set of checks for the settings route and for the settings an export
// carries.

import { trimSpace } from "./memory/clean";
import { defaultParams, InvalidParamsError, type Params, validateParams } from "./store/decay";
import { knownZone, UTC } from "./zone";

// SettingsChange is a change whose shape has been checked: the parameters
// given (the others stay as they are), a time zone, or both.
export interface SettingsChange {
  params?: Partial<Params>;
  timeZone?: string;
}

// Settings are the settings in force.
export interface Settings {
  params: Params;
  timeZone: string;
}

export const paramNames = Object.keys(defaultParams()) as (keyof Params)[];

// readParams checks the shape of a set of parameters, or says what is wrong.
export function readParams(x: unknown): Partial<Params> | string {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return "params must be an object";
  const params: Partial<Params> = {};
  for (const [p, n] of Object.entries(x as Record<string, unknown>)) {
    if (!(paramNames as string[]).includes(p)) {
      return `unknown parameter ${JSON.stringify(p)}: the parameters are ${paramNames.join(", ")}`;
    }
    if (typeof n !== "number") return `parameter ${p} must be a number`;
    params[p as keyof Params] = n;
  }
  return params;
}

export function unknownZoneMessage(zone: string): string {
  return `unknown time zone ${JSON.stringify(zone)}: give an IANA name such as Asia/Shanghai`;
}

// resolveSettings applies a change to the parameters in force and checks
// the result as the store does, or says what is wrong. The zone comes back
// as the runtime names it, and only when one was given.
export function resolveSettings(change: SettingsChange, current: Params): { params: Params; timeZone?: string } | string {
  let timeZone: string | undefined;
  if (change.timeZone !== undefined) {
    timeZone = knownZone(trimSpace(change.timeZone));
    if (timeZone === undefined) return unknownZoneMessage(change.timeZone);
  }
  const params: Params = { ...current, ...change.params };
  try {
    validateParams(params);
  } catch (err) {
    if (err instanceof InvalidParamsError) return err.message;
    throw err;
  }
  return timeZone === undefined ? { params } : { params, timeZone };
}

export function paramsDiffer(a: Params, b: Params): boolean {
  return paramNames.some((k) => !Object.is(a[k], b[k]));
}

// isDefault reports whether settings are those of a memory never changed,
// whose export carries no settings and is then what Go writes.
export function isDefault(s: Settings): boolean {
  return !paramsDiffer(s.params, defaultParams()) && s.timeZone === UTC;
}
