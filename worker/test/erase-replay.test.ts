// New on this platform: a replay after an erasure reproduces the derived
// tables as they were lived, whatever the erased memory was and wherever it
// stood. In the Go build it does not (see applyRemember).

import { describe, expect, it } from "vitest";
import { countFindings, LevelProblem, reportText } from "../src/store/check";
import { encodeContent } from "../src/store/content";
import { encodeRemember, encodeSession, type RememberEvent } from "../src/store/events";
import type { Store } from "../src/store/store";
import { amend, ent, entry, reflectOn } from "./amend-helpers";
import { dump, get, hour, listed, read, remember, session, t0, withStore } from "./helpers";

interface Life {
  a: string;
  b: string;
  targets: Record<string, string>;
  others: Record<string, string>;
}

// life writes memories of every kind and standing, and names the eight that
// the tests erase.
function life(s: Store): Life {
  const a = session(s, t0, "model-a", "cli");
  const b = session(s, t0 + hour, "model-b", "desktop");
  const f1 = remember(s, t0, a, "用户纠正了我的理解", "第一件事。");
  const f2 = remember(s, t0, a, "用户给我看了他的猫", "第二件事。");
  const f3 = remember(s, t0, a, "阿明帮我查了代理", "proxy 的事。");
  const f4 = remember(s, t0, a, "阿明又帮了忙", "第四件事。");
  const f5 = remember(s, t0, b, "另一次对话里也这样", "第五件事。");
  const f6 = remember(s, t0, b, "一件小事", "第六件事。");
  const f7 = remember(s, t0, b, "记错了的事", "猫叫年糕。");
  const f8 = remember(s, t0, b, "又一次先问清楚", "第八件事。");
  const f9 = remember(s, t0, b, "还没想过的事", "纠正之后。");
  listed(s, f1, f2, f9);
  read(s, f3);

  const [episode, a1, self1] = reflectOn(s, a, [
    ent("episode", "一起定下了方向", f1, f2),
    { ...ent("impression", "阿明很细心", f3), about: "阿明" },
    entry({ kind: "self", gist: "我动手前会先问清楚", context: "做设计的时候", importance: 0.5, from: [f3, f4, f5] }),
  ], f6) as [string, string, string];
  const correction = s.correct(t0 + 2 * hour, f7, {
    sessionId: b, moment: "other", source: "lived", importance: 0.5, gist: "记对了的事", body: "猫叫汤圆。", happened: t0,
  });
  const [a2, self2, reading] = reflectOn(s, b, [
    { ...ent("impression", "阿明细心，也爱开玩笑", f4), about: "阿明" },
    entry({ kind: "self", gist: "我多数时候先问清楚", importance: 0.5, from: [f6, f8], ref: self1 }),
    entry({ kind: "reading", gist: "现在看，那次纠正很及时", importance: 0.5, ref: f1 }),
  ]) as [string, string, string];
  amend(s, a, "pin", episode);
  amend(s, b, "reweigh", correction, 0.8);
  s.addPreference(t0 + 3 * hour, a, "闲聊不用记", 30);
  return {
    a, b,
    targets: {
      "a fragment": f9,
      "a fragment an episode absorbed": f1,
      "a memory that was corrected": f7,
      "the correction": correction,
      "an impression that had replaced another": a2,
      "an impression that was itself replaced later": a1,
      "a statement about oneself with an earlier version": self2,
      "a reading": reading,
    },
    others: { episode, self1, f2, f3, f4, f8 },
  };
}

// afterwards lives a little more after the erasures, touching the erased
// memories where it can.
function afterwards(s: Store, l: Life, erased: string[]): void {
  const f10 = remember(s, t0 + 5 * hour, l.a, "后来的事", "阿明说了猫的事。");
  listed(s, ...erased, f10);
  read(s, ...erased, l.others.f2!);
  reflectOn(s, l.a, [{ ...ent("impression", "阿明一直很可靠", f10), about: "阿明" }], l.others.f8!);
  amend(s, l.b, "retract", l.others.f3!);
}

function rebuildsTheSame(s: Store, storage: DurableObjectStorage): void {
  const before = dump(s, storage);
  s.rebuild();
  expect(dump(s, storage), "the replay differs from what was lived").toBe(before);
  const r = s.check();
  expect(countFindings(r, LevelProblem), reportText(r)).toBe(0);
}

const cases = [
  "a fragment",
  "a fragment an episode absorbed",
  "a memory that was corrected",
  "the correction",
  "an impression that had replaced another",
  "an impression that was itself replaced later",
  "a statement about oneself with an earlier version",
  "a reading",
];

describe("a replay after an erasure", () => {
  it.each(cases)("reproduces the tables when %s is erased", (name) =>
    withStore((s, storage) => {
      const l = life(s);
      const id = l.targets[name]!;
      const was = get(s, id);
      s.erase(t0 + 4 * hour, l.b, id, "");
      const m = get(s, id);
      // It keeps its standing otherwise: what replaced or absorbed it, and
      // what it replaced, stay as they were.
      expect([m.state, m.stateBy, m.gist, m.about, m.context]).toEqual(["erased", was.stateBy, "", "", ""]);
      afterwards(s, l, [id]);
      rebuildsTheSame(s, storage);
    }));

  it("reproduces the tables when all of them are erased", () =>
    withStore((s, storage) => {
      const l = life(s);
      const ids = Object.values(l.targets);
      ids.forEach((id, i) => s.erase(t0 + 4 * hour + i, l.a, id, "the user asked"));
      afterwards(s, l, ids);
      rebuildsTheSame(s, storage);
    }));

  // What an erased memory had replaced stays replaced, and check says so.
  it("keeps replaced what an erased memory had replaced", () =>
    withStore((s, storage) => {
      const l = life(s);
      s.erase(t0 + 4 * hour, l.b, l.targets["an impression that had replaced another"]!, "");
      s.erase(t0 + 4 * hour, l.b, l.targets["the correction"]!, "");
      s.rebuild();
      const a1 = get(s, l.targets["an impression that was itself replaced later"]!);
      const f7 = get(s, l.targets["a memory that was corrected"]!);
      expect([a1.state, f7.state]).toEqual(["superseded", "superseded"]);
      expect(s.impressions(["阿明"])).toEqual([]);
      const found = s.check().findings.find((f) => f.code === "nothing-in-its-place");
      expect(found?.ids.sort()).toEqual([a1.id, f7.id].sort());
      expect(storage.sql.exec(`SELECT count(*) AS c FROM events WHERE payload LIKE '%"replaces"%'`).one().c).toBe(1);
    }));
});

// A log the Go build wrote has no replaces: an impression replaces those
// about the same name, as Go does, and replaces nothing when its own content
// is gone.
describe("a log without replaces", () => {
  it("replaces impressions by what they are about", () =>
    withStore((s, storage) => {
      const exec = (kind: string, payload: string) =>
        storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, ?, ?)`, t0, kind, payload);
      exec("session", encodeSession({ id: "s_aaaaaaaa", model: "model-a", client: "cli" }));
      const write = (id: string, about: string, keep: boolean, raw?: string) => {
        const c = encodeContent({ gist: "印象 " + id, about });
        if (keep) storage.sql.exec(`INSERT INTO contents(id, data) VALUES(?, ?)`, id, c.data);
        const e: RememberEvent = {
          id, session: "s_aaaaaaaa", kind: "impression", moment: "", source: "lived", importance: 0.5, intensity: 0,
          hash: c.hash, corrects: "", happened: 0, from: [], ref: "", milestone: false,
        };
        exec("remember", raw ?? encodeRemember(e));
      };
      write("m_i1", "X", true);
      write("m_i2", "X", true);
      write("m_i3", "Y", true);
      write("m_i0", "", true); // about nothing: the store does not refuse it
      write("m_i4", "X", false); // erased: its content is gone, and with it what it was about
      exec("erase", `{"session":"s_aaaaaaaa","id":"m_i4"}`);
      // A field that is there but empty replaces nothing, whatever it is about.
      const c5 = encodeContent({ gist: "印象 m_i5", about: "Y" });
      storage.sql.exec(`INSERT INTO contents(id, data) VALUES(?, ?)`, "m_i5", c5.data);
      exec("remember", `{"id":"m_i5","session":"s_aaaaaaaa","kind":"impression","moment":"","source":"lived","importance":0.5,"hash":"${c5.hash}","replaces":[]}`);
      s.rebuild();

      const st = (id: string) => [get(s, id).state, get(s, id).stateBy];
      expect([st("m_i1"), st("m_i2"), st("m_i3"), st("m_i0"), st("m_i4"), st("m_i5")])
        .toEqual([["superseded", "m_i2"], ["", ""], ["", ""], ["", ""], ["erased", ""], ["", ""]]);
      expect(s.impressions(["X", "Y"]).map((m) => m.id)).toEqual(["m_i2", "m_i3", "m_i5"]);
      const r = s.check();
      expect(countFindings(r, LevelProblem), reportText(r)).toBe(0);
      const before = dump(s, storage);
      s.rebuild();
      expect(dump(s, storage)).toBe(before);
    }));

  // A memory whose content is gone with no erase event was lost. It stands
  // through the replay, so later events reach it, and is marked erased at the
  // end, as Go marks it.
  it("marks a memory erased that lost its content", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const f = remember(s, t0, sess, "会丢的", "正文");
      const [ep] = reflectOn(s, sess, [ent("episode", "经历", f)]);
      storage.sql.exec(`DELETE FROM contents WHERE id = ?`, f);
      s.rebuild();
      const m = get(s, f);
      expect([m.state, m.stateBy, m.gist]).toEqual(["erased", ep, ""]);
      expect(s.check().findings.find((x) => x.code === "content-lost")?.ids).toEqual([f]);
    }));
});
