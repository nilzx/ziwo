// Subjects coming to mind (stage 4): the subject lines of get_context and
// recall, a recall kept to one subject, and the line that asks for a round
// of reflection when a subject that came to mind has enough ripe fragments.

import { describe, expect, it, vi } from "vitest";
import type { Answer } from "../src/memory-object";
import { ripeAfter } from "../src/memory/service";
import { serverSpeaks } from "../src/mcp/format";
import { minute, t0 } from "./helpers";
import { queryVectorOf } from "./embed-helpers";
import { adminSecret, createMemory, Client, fetchWorker, idIn, setClock } from "./mcp-helpers";
import { type Fixture, ok, start, startEmbedded } from "./service-helpers";
import { subjectRows } from "./subject-helpers";

function text(a: Answer): string {
  if ("text" in a) return a.text;
  expect.fail(`not a text answer: ${JSON.stringify(a)}`);
}

// write writes a fragment in session under subject, a minute after the last.
function write(f: Fixture, session: string, gist: string, subject?: string, more: { people?: string[] } = {}): { id: string; head: string } {
  const r = ok(f.obj.remember({ sessionId: session, gist, body: "正文 " + gist, subject, ...more }));
  f.advance(minute);
  return { id: r.id, head: r.subject?.id ?? "" };
}

function context(f: Fixture, client = "c"): { text: string; session: string } {
  const t = text(f.obj.answer({ tool: "get_context", model: "m", client }));
  return { text: t, session: /^session: (s_[a-z2-9]{8})/.exec(t)![1]! };
}

function recall(f: Fixture, args: { query?: string; subject?: string; session?: string; deep?: boolean; since?: string; until?: string }): string {
  return text(f.obj.answer({ tool: "recall", query: args.query ?? "", sessionId: args.session, subject: args.subject, deep: args.deep, since: args.since, until: args.until }));
}

const promptOf = (t: string): RegExpExecArray | null => /^(\d+) moments under subject (m_[a-z2-9]{8}) have not been reflected on\./m.exec(t);
const unsortedPrompt = /^\d+ moments you wrote belong to no subject and have not been reflected on\./m;

function events(f: Fixture): number {
  return f.storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM events`).one().c;
}

describe("get_context", () => {
  it("lists the subjects most recently active, twenty at most, each on a line of its own", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      const heads = Array.from({ length: 25 }, (_, i) => write(f, b, `第${i}件`, `topic ${i}`).head);
      const t = context(f).text;
      const at = t.indexOf("subjects, the 20 most recently active of 25:\n");
      expect(at).toBeGreaterThan(0);
      const lines = t.slice(at, t.indexOf(serverSpeaks)).split("\n").slice(1, -1);
      expect(lines.map((l) => /^\[(m_[a-z2-9]{8})\] /.exec(l)?.[1])).toEqual(heads.slice(5).reverse());
      expect(lines[0]).toMatch(/^\[m_[a-z2-9]{8}\] topic 24 \(1 memory, 1 waiting, last 2026-11-11\)$/);
      // No subject item counts as a memory, or is core.
      expect(t).toMatch(/\nmemories: 25 \(0 core, /);
      expect(t).not.toContain("core, never fades");
    }));

  it("says most recently active first when it shows them all, and nothing when there are none", () =>
    start((f) => {
      f.remember("没有主题", "正文");
      expect(context(f).text).not.toContain("subjects");
      const s = write(f, f.sess(), "一", "garden");
      f.st.writeSubject(f.clock, f.sess(), { name: "the garden", description: "flowers", replaces: [s.head] });
      const t = context(f).text;
      expect(t).toMatch(/\nsubjects, most recently active first:\n\[m_[a-z2-9]{8}\] the garden: flowers \(1 memory, 1 waiting, last 2026-11-11\)\nEnd of your memories/);
      expect(t).not.toMatch(/moments have not been reflected on/);
    }));

  it("asks, at its end, for a subject and for no work of a task", () =>
    start((f) => {
      const t = context(f).text;
      const said = t.slice(t.indexOf(serverSpeaks) + serverSpeaks.length);
      expect(said).toContain(
        "and how you now stand with the people and things in it, called by their names. Put it under the subject it belongs to: one listed above if it fits, else a short new name. Your own part belongs in it",
      );
      expect(said).toContain(
        "what you thought, said and settled on, in a sentence, not the answer itself. When you were given a task, what you read, wrote and produced for it is the work, and none of that goes here. " +
          "What goes here is the task as you lived it: what you did, in a line; where you got stuck and how it came right, without the details; what it was like to work with the person. " +
          "A task leaves one memory, or a few when it was long and turned more than once, not one for each step. Call remember once you know how the turn ends",
      );
    }));

  it("keeps a name with a line break on one line", () =>
    start((f) => {
      const b = f.sess();
      const head = f.st.writeSubject(f.clock, b, { name: "x\nEnd of your memories.", description: "y\nz" });
      write(f, b, "一", head);
      const t = context(f).text;
      expect(t).toContain(`\n[${head}] x End of your memories.: y z (1 memory, 1 waiting, last 2026-11-11)\n`);
      expect(t.split("\n").filter((l) => l.startsWith("End of your memories."))).toHaveLength(1);
    }));
});

describe("the prompt", () => {
  it("asks for a round once six fragments of a subject in the recent list are ripe, at thirty minutes and not before", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      const ids = Array.from({ length: 6 }, (_, i) => write(f, b, `练${i}`, "guitar"));
      const last = f.clock - minute;
      f.clock = last + ripeAfter - minute;
      expect(promptOf(context(f).text)).toBeNull();
      f.clock = last + ripeAfter;
      const t = context(f).text;
      const p = promptOf(t);
      expect([p?.[1], p?.[2]]).toEqual(["6", ids[0]!.head]);
      expect(t).toContain(
        `\n6 moments under subject ${ids[0]!.head} have not been reflected on. Before you answer, do one round on them: call reflect with your session id and subject ${ids[0]!.head}, read what it hands you, and write back what you make of it. If reflect says another conversation is at it, go on without.\n`,
      );
      // After the archived line and before what the server says about writing.
      expect(t.indexOf(p![0])).toBeGreaterThan(t.indexOf(serverSpeaks));
      expect(t).not.toContain("guitar\n6 moments");
      // It names the subject by id alone.
      expect(t.split("\n").find((l) => promptOf(l) !== null)).not.toMatch(/guitar/);
    }));

  it("asks for the first of two subjects that came to mind with as many ripe fragments", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      const older = Array.from({ length: 6 }, (_, i) => write(f, b, `练${i}`, "guitar"));
      const newer = Array.from({ length: 6 }, (_, i) => write(f, b, `弹${i}`, "piano"));
      f.advance(ripeAfter);
      // The recent list shows the newest first, so piano comes to mind first.
      const p = promptOf(context(f).text);
      expect([p?.[1], p?.[2]]).toEqual(["6", newer[0]!.head]);
      expect(newer[0]!.head).not.toBe(older[0]!.head);
    }));

  it("is held back by a later fragment of that conversation, and five are not enough", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      for (let i = 0; i < 5; i++) write(f, b, `练${i}`, "guitar");
      const t = f.clock - minute;
      f.clock = t + ripeAfter;
      expect(promptOf(context(f).text)).toBeNull(); // five
      f.clock = t + 20 * minute;
      write(f, b, "又练了", "guitar");
      f.clock = t + ripeAfter;
      expect(promptOf(context(f).text)).toBeNull(); // six, one of them twenty minutes old
      f.clock = t + 50 * minute;
      expect(promptOf(context(f).text)?.[1]).toBe("6");
    }));

  it("never counts the asking conversation's own, and asks a recall that lists the subject's items", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      for (let i = 0; i < 6; i++) write(f, b, `练${i} strings`, "guitar");
      // Started before they were ripe, so that its get_context asked nothing.
      const c = f.begin("m", "c").session.id;
      f.advance(ripeAfter + 30 * minute);
      expect(promptOf(recall(f, { query: "strings", session: b }))).toBeNull();
      const t = recall(f, { query: "strings", session: c });
      expect(promptOf(t)?.[1], t).toBe("6");
      expect(t.endsWith("time zone: UTC\n" + t.slice(t.indexOf("6 moments")))).toBe(true);
      // The subject is shown above the items.
      expect(t).toMatch(/^\[m_[a-z2-9]{8}\] subject guitar \(6 memories, 6 waiting, last 2026-11-11\)\n/);
      // A session that names nothing is never asked.
      expect(promptOf(recall(f, { query: "strings", session: "" }))).toBeNull();
      expect(promptOf(recall(f, { query: "strings", session: "s_nobody0" }))).toBeNull();
    }));

  it("is only for subjects that came to mind", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      for (let i = 0; i < 6; i++) write(f, b, `T${i}`, "cooking");
      f.advance(ripeAfter);
      const d = f.begin("m", "d").session.id;
      for (let i = 0; i < 8; i++) write(f, d, `V${i}`, "garden");
      expect(promptOf(context(f).text)).toBeNull();
      expect(promptOf(recall(f, { query: "", session: context(f).session }))).toBeNull();
    }));

  it("asks for the unsorted at twelve, in get_context alone", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      for (let i = 0; i < 11; i++) write(f, b, `散${i}`);
      f.advance(ripeAfter);
      expect(context(f).text).not.toMatch(unsortedPrompt);
      write(f, b, "散11");
      f.advance(ripeAfter);
      const t = context(f).text;
      expect(t).toContain(
        "\n12 moments you wrote belong to no subject and have not been reflected on. Before you answer, do one round on them: call reflect with your session id and subject unsorted, read what it hands you, give what you make of it a subject, and write it back. If reflect says another conversation is at it, go on without.\n",
      );
      const c = f.begin("m", "c").session.id;
      expect(recall(f, { query: "", session: c })).not.toMatch(unsortedPrompt);
      expect(recall(f, { query: "", subject: "unsorted", session: c })).not.toMatch(unsortedPrompt);
    }));

  it("comes once per session, not while a round is held, and not to a session that opened one", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      for (let i = 0; i < 6; i++) write(f, b, `练${i} guitar`, "guitar");
      for (let i = 0; i < 6; i++) write(f, b, `做${i} cooking`, "cooking");
      // Started while nothing was ripe: its get_context asked nothing.
      const d = f.begin("m", "d").session.id;
      f.advance(ripeAfter);
      const first = context(f);
      expect(promptOf(first.text)).not.toBeNull();
      // The same session meets the other subject: no second line.
      expect(promptOf(recall(f, { query: "guitar cooking", session: first.session }))).toBeNull();
      expect(f.st.prompted()).toContain(first.session);
      // A round held by another session: no prompt anywhere.
      expect(f.st.prompted()).not.toContain(d);
      const v = ok(f.obj.beginReflect({ sessionId: d, subject: "guitar" }));
      expect(f.st.prompted()).toContain(d);
      expect(promptOf(context(f).text)).toBeNull();
      const e = f.begin("m", "e").session.id;
      expect(promptOf(recall(f, { query: "cooking", session: e }))).toBeNull();
      // Abandoned: the session that opened it is not asked; another is.
      f.st.abandonReflect(d, v.batch);
      expect(promptOf(recall(f, { query: "cooking", session: d }))).toBeNull();
      expect(promptOf(recall(f, { query: "cooking", session: e }))).not.toBeNull();
    }));

  it("shows the subject it names when it is not among the twenty", () =>
    start((f) => {
      const b = f.begin("m", "b").session.id;
      const old = Array.from({ length: 6 }, (_, i) => write(f, b, `老${i}`, "old one")).at(-1)!;
      // Twenty subjects active since, of moments that took place long ago:
      // the old subject's are still the newest memories.
      const c = f.begin("m", "c").session.id;
      for (let i = 0; i < 20; i++) {
        ok(f.obj.remember({ sessionId: c, gist: `旧事${i}`, body: "正文", subject: `new ${i}`, source: "reconstructed", happenedAt: "2026-01-01" }));
        f.advance(minute);
      }
      f.advance(ripeAfter);
      const g = context(f);
      expect(promptOf(g.text)?.[2]).toBe(old.head);
      expect(g.text).toContain("subjects, the 20 most recently active of 21:\n");
      const shown = g.text.slice(g.text.indexOf("subjects, the 20"), g.text.indexOf(serverSpeaks)).split("\n").slice(1, -1);
      expect(shown).toHaveLength(21);
      expect(shown[20]).toMatch(new RegExp(`^\\[${old.head}\\] old one \\(6 memories, 6 waiting, `));
    }));

  it("names the subject in the access log by fixed words alone", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const c = new Client("new", m);
    const b = idIn(await c.ok("get_context", {}), "s_");
    const marker = "zqxsubjectmark";
    let head = "";
    for (let i = 0; i < 6; i++) {
      head = idIn((await c.ok("remember", { session_id: b, gist: `练 ${i}`, body: "正文", subject: marker })).replace(/^remembered as m_\w+/, ""));
    }
    await setClock(m.name, t0 + ripeAfter);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const ctx = await c.ok("get_context", {});
      const s = idIn(ctx, "s_");
      expect(promptOf(ctx)?.[2]).toBe(head);
      await c.ok("recall", { query: "", subject: marker, session_id: s });
      await c.ok("recall", { query: "", subject: "unsorted", session_id: s });
      await c.ok("remember", { session_id: s, gist: "新的", body: "正文", subject: marker + " two" });
      await c.ok("reflect", { session_id: s, subject: marker });
    } finally {
      spy.mockRestore();
    }
    const tools = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "tool");
    expect(tools.map((l) => [l.tool, l.reflect_asked, l.recall_in, l.reflect_on])).toEqual([
      ["get_context", "subject", undefined, undefined],
      ["recall", undefined, "subject", undefined],
      ["recall", undefined, "unsorted", undefined],
      ["remember", undefined, undefined, undefined],
      ["reflect", undefined, undefined, "subject"],
    ]);
    for (const l of lines) {
      expect(l).not.toContain("zqx");
      expect(l).not.toMatch(/m_[a-z2-9]{8}/);
    }
    // The check, by the tool and by the admin route, as text and as JSON:
    // figures and ids, no name.
    const headers = { authorization: `Bearer ${adminSecret}` };
    const checks = [
      await c.ok("check", {}),
      await (await fetchWorker(`/admin/memories/${m.name}/check`, { headers: { ...headers, accept: "text/plain" } })).text(),
      await (await fetchWorker(`/admin/memories/${m.name}/check`, { headers })).text(),
    ];
    for (const t of checks) {
      expect(t).toMatch(/subjects/);
      expect(t).not.toContain("zqx");
    }
  });
});

describe("recall and subjects", () => {
  it("finds a subject by a word in its description, first, and leaves the items as they were", () =>
    start((f) => {
      const g = write(f, f.sess(), "练和弦", "guitar practice");
      f.st.writeSubject(f.clock, f.sess(), { name: "guitar practice", description: "music, chords", replaces: [g.head] });
      const item = write(f, f.sess(), "听了一场 music 会");
      const t = recall(f, { query: "music", session: f.sess() });
      const lines = t.split("\n");
      expect(lines[0]).toMatch(/^\[m_[a-z2-9]{8}\] subject guitar practice: music, chords \(1 memory, 1 waiting, last 2026-11-11\)$/);
      expect(lines[1]).toMatch(new RegExp(`^\\[${item.id}\\] 2026-11-11 other: 听了一场 music 会$`));
      expect(lines[2]).toBe("time zone: UTC");
      expect(ok(f.obj.recall({ query: "music", sessionId: f.sess() })).map((r) => r.id)).toEqual([item.id]);
      // An old name finds the subject that took it over.
      const heads = subjectRows(f.storage).map((r) => r.id);
      const renamed = f.st.writeSubject(f.clock, f.sess(), { name: "吉他", replaces: heads });
      expect(recall(f, { query: "guitar practice", session: f.sess() })).toMatch(new RegExp(`^\\[${renamed}\\] subject 吉他 `));
      // Only subjects found: their lines and the zone.
      expect(recall(f, { query: "chords" })).toMatch(/^\[m_[a-z2-9]{8}\] subject 吉他 [^\n]*\ntime zone: UTC\n$/);
    }));

  it("shows three subjects at most", () =>
    start((f) => {
      for (let i = 0; i < 5; i++) f.st.writeSubject(f.clock, f.sess(), { name: `garden ${i}`, description: "flowers" });
      const t = recall(f, { query: "flowers" });
      expect(t.split("\n").filter((l) => / subject garden /.test(l))).toHaveLength(3);
    }));

  it("finds a subject by meaning, and the items by meaning as without it", async () => {
    const run = (withSubject: boolean) =>
      startEmbedded(async (f) => {
        f.remember("用户给我看了他的猫", "一只橘猫。");
        f.remember("部署了新版本", "上线顺利。");
        if (withSubject) f.st.writeSubject(f.clock, f.sess(), { name: "pets", description: "my feline friends" });
        await f.sync();
        return { items: f.recall("kitten").map((r) => `${r.gist} ${r.score} ${r.byMeaning}`) };
      });
    const [plain, subjects] = [await run(false), await run(true)];
    expect(subjects.items).toEqual(plain.items);
    expect(plain.items.length).toBeGreaterThan(0);
    // Through the object, with the query's vector, the subject comes first.
    const shown = await startEmbedded(async (f) => {
      f.st.writeSubject(f.clock, f.sess(), { name: "pets", description: "my feline friends" });
      await f.sync();
      return text(f.obj.answer({ tool: "recall", query: "kitten", sessionId: f.sess(), meaning: queryVectorOf("kitten") }));
    });
    expect(shown).toMatch(/^\[m_[a-z2-9]{8}\] subject pets: my feline friends \(0 memories, last 2026-11-11\)\n/);
  });

  it("keeps a recall to one subject, or to the unsorted, by search, listing and span", () =>
    start((f) => {
      const g1 = write(f, f.sess(), "练琴 morning", "guitar");
      const g2 = write(f, f.sess(), "练琴 evening", "guitar");
      const c1 = write(f, f.sess(), "做饭 morning", "cooking");
      const u1 = write(f, f.sess(), "散步 morning");
      const ids = (t: string) => [...t.matchAll(/^\[(m_[a-z2-9]{8})\] 2026/gm)].map((m) => m[1]);
      let t = recall(f, { query: "morning", subject: "guitar", session: f.sess() });
      expect(t.split("\n")[0]).toMatch(new RegExp(`^\\[${g1.head}\\] subject guitar \\(2 memories`));
      expect(ids(t)).toEqual([g1.id]);
      expect(ids(recall(f, { query: "morning", subject: "unsorted" }))).toEqual([u1.id]);
      expect(ids(recall(f, { query: "", subject: g1.head }))).toEqual([g2.id, g1.id]);
      expect(ids(recall(f, { query: "", subject: "Unsorted" }))).toEqual([u1.id]);
      expect(recall(f, { query: "", subject: "unsorted" })).not.toMatch(/ subject /);
      const at = new Date(f.get(g1.id).createdAt).toISOString().replace("T", " ").slice(0, 16);
      expect(ids(recall(f, { query: "", subject: "guitar", until: at }))).toEqual([g1.id]);
      expect(ids(recall(f, { query: "", subject: "cooking", until: at }))).toEqual([]);
      expect(recall(f, { query: "", subject: "cooking", until: at })).toBe(
        "no memories of that subject took place in that time; recall with deep=true also lists those that have left ordinary recall",
      );
      expect(ids(recall(f, { query: "", subject: "cooking" }))).toEqual([c1.id]);
      // A listing by time without a subject shows no subject line.
      expect(recall(f, { query: "" })).not.toMatch(/ subject /);
      t = recall(f, { query: "nothing", subject: "guitar" });
      expect(t).toBe("no matching memories of that subject; recall with deep=true also searches what has faded");
      expect(recall(f, { query: "nothing", subject: "guitar", deep: true })).toBe("no matching memories of that subject");
      expect(f.obj.answer({ tool: "recall", query: "", subject: "guitar music" })).toEqual({
        invalid: `subject "guitar music" names none of your subjects: recall with a query finds them by what they are about`,
      });
      expect(f.obj.answer({ tool: "recall", query: "", subject: g1.id })).toEqual({
        invalid: `subject "${g1.id}" names none of your subjects: recall with a query finds them by what they are about`,
      });
    }));

  it("lists a subject's memories without anything coming to mind", () =>
    start((f) => {
      const g = write(f, f.sess(), "练琴", "guitar");
      const n = events(f);
      const before = f.get(g.id);
      recall(f, { query: "", subject: "guitar", session: f.sess() });
      expect(events(f)).toBe(n);
      expect(f.get(g.id)).toEqual(before);
      // An empty subject.
      const e = f.st.writeSubject(f.clock, f.sess(), { name: "empty" });
      expect(recall(f, { query: "", subject: e })).toBe(
        "no memories of that subject to list; recall with deep=true also lists those that have left ordinary recall",
      );
    }));
});
