// Forgetting is driven by experience, not by the calendar. The clock is the
// number of moments written as they happened: it advances by one each time
// such a moment is written and stands still otherwise. What is written
// afterwards about the past (an account put together by reflecting, a
// correction, a memory reconstructed from a record) does not advance it.
//
// A memory has a strength S, counted in memories. When n memories have been
// written since it last came to mind, the chance that it comes to mind again
// is R = exp(-n / S).
//
//   - Being listed by a search only restarts n.
//   - Being read in full multiplies S by 1 + boost*(1 - R), where R is taken
//     over the memories written since it was last read.
//
// Nothing is rewritten as the clock advances. When a memory is written or
// comes to mind, the clock values at which R will cross the fade and archive
// thresholds are stored. A memory's tier is a comparison against the clock at
// the time of asking. This file is a port of decay.go.

import type { Memory } from "./types";

// Params tune how memories strengthen and fade. They belong to each memory,
// are kept in meta, and changing them rebuilds the derived tables.
export interface Params {
  // Strength of an ordinary memory (lived, importance 0.5, no feeling).
  baseStrength: number;
  // A reading multiplies strength by 1 + recallBoost*(1 - R).
  recallBoost: number;
  // R below which only a memory's gist stays findable.
  fadeBelow: number;
  // R below which a memory leaves ordinary search.
  archiveBelow: number;
  // Importance at or above which a memory never fades.
  coreImportance: number;
  // Feeling intensity at or above which a memory never fades.
  coreFeeling: number;
}

// defaultParams are the Go build's defaults. With them an ordinary memory
// fades once about 120 newer memories have been written without it coming to
// mind, and is archived after about 300.
export function defaultParams(): Params {
  return {
    baseStrength: 100,
    recallBoost: 2,
    fadeBelow: 0.3,
    archiveBelow: 0.05,
    coreImportance: 0.9,
    coreFeeling: 0.9,
  };
}

// Strength is kept within these bounds so the stored crossings stay finite.
export const minStrength = 0.01;
export const maxStrength = 1e9;

export class InvalidParamsError extends Error {
  override name = "InvalidParamsError";
}

// validateParams throws on the first thing wrong with p. The conditions are
// written as negations so that NaN fails them, as in Go.
export function validateParams(p: Params): void {
  if (!(p.baseStrength > 0 && p.baseStrength <= maxStrength)) {
    throw new InvalidParamsError(`base strength must be positive and at most ${maxStrength}, got ${p.baseStrength}`);
  }
  if (!(p.recallBoost >= 0)) {
    throw new InvalidParamsError(`recall boost must not be negative, got ${p.recallBoost}`);
  }
  if (!(p.archiveBelow > 0 && p.archiveBelow < p.fadeBelow && p.fadeBelow < 1)) {
    throw new InvalidParamsError(
      `need 0 < archive threshold < fade threshold < 1, got archive ${p.archiveBelow}, fade ${p.fadeBelow}`,
    );
  }
  if (!(p.coreImportance > 0 && p.coreFeeling > 0)) {
    throw new InvalidParamsError(
      `core thresholds must be positive, got importance ${p.coreImportance}, feeling ${p.coreFeeling}`,
    );
  }
}

export function clampStrength(s: number): number {
  return Math.min(Math.max(s, minStrength), maxStrength);
}

// initialStrength is the strength a memory starts with. Importance moves it by
// up to a factor of four either way, a strong feeling up to doubles it, and
// what was only told or inferred starts weaker than what was lived.
export function initialStrength(p: Params, importance: number, intensity: number, source: string): number {
  let s = p.baseStrength * Math.pow(4, 2 * importance - 1) * (1 + intensity);
  switch (source) {
    case "told":
      s *= 0.7;
      break;
    case "inferred":
      s *= 0.4;
      break;
  }
  return clampStrength(s);
}

// reinforced is the strength after a reading at retention r.
export function reinforced(p: Params, strength: number, r: number): number {
  return clampStrength(strength * (1 + p.recallBoost * (1 - r)));
}

// isCore reports whether a memory with these marks never fades.
export function isCore(p: Params, importance: number, intensity: number): boolean {
  return importance >= p.coreImportance || intensity >= p.coreFeeling;
}

// crossings returns the clock values at which a memory that last came to mind
// at clock value touched, with the given strength, fades and is archived.
export function crossings(p: Params, touched: number, strength: number): { fadeAt: number; archiveAt: number } {
  return {
    fadeAt: touched + strength * Math.log(1 / p.fadeBelow),
    archiveAt: touched + strength * Math.log(1 / p.archiveBelow),
  };
}

// retention is R once n memories have been written, at the given strength.
export function retention(strength: number, n: number): number {
  if (n <= 0) return 1;
  return Math.exp(-n / strength);
}

// Tier is how reachable a memory is at a given point.
export type Tier = "core" | "active" | "faded" | "archived";

// tierOf reports how reachable the memory is when the clock reads clock.
export function tierOf(m: Memory, clock: number): Tier {
  if (m.core) return "core";
  if (clock >= m.archiveAt) return "archived";
  if (clock >= m.fadeAt) return "faded";
  return "active";
}

// retentionOf is R when the clock reads clock: 1 right after the memory came
// to mind, falling towards 0 as more memories are written.
export function retentionOf(m: Memory, clock: number): number {
  if (m.core) return 1;
  return retention(m.strength, clock - m.touchedOrd);
}

// TierCounts says how many memories are in each tier.
export interface TierCounts {
  core: number;
  active: number;
  faded: number;
  archived: number;
}

export function tierTotal(c: TierCounts): number {
  return c.core + c.active + c.faded + c.archived;
}
