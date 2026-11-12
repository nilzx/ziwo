// The access log: one JSON line per request and one per tool call, through
// console.log. Figures and fixed words, and of what a caller chooses only
// the method, the path (which names the memory), the agent and the protocol
// version, each cut to length: never an argument, a result, a token, a body
// or anything a memory says.

export type LogFields = Record<string, string | number | boolean>;

export function logLine(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}

// clip cuts s to at most n characters (code points).
export function clipText(s: string, n: number): string {
  const cps = [...s];
  return cps.length > n ? cps.slice(0, n).join("") : s;
}
