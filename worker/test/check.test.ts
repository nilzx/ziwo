// Port of internal/store/check_test.go.

import { describe, expect, it } from "vitest";
import { countFindings, type Finding, LevelNote, LevelProblem, LevelWarning, type Report, reportText } from "../src/store/check";
import type { Store } from "../src/store/store";
import { amend, ent, entry, reflectOn } from "./amend-helpers";
import { hour, listed, read, remember, rememberWith, session, t0, withStore } from "./helpers";

// found returns the finding with the given code and level, or fails.
function found(r: Report, level: string, code: string): Finding {
  const f = r.findings.find((x) => x.code === code);
  expect(f, `the check did not find [${code}]:\n${reportText(r)}`).toBeDefined();
  expect(f!.level, `[${code}]`).toBe(level);
  return f!;
}

function figure(r: Report, name: string): string {
  const f = r.figures.find((x) => x.name === name);
  expect(f, `figure ${name}`).toBeDefined();
  return f!.value;
}

// life writes a memory with a little of everything, as Go's life in
// export_test.go does.
function life(s: Store): void {
  const a = session(s, t0, "model-a", "cli");
  const b = session(s, t0 + hour, "model-b", "desktop");
  const f1 = remember(s, t0, a, "用户让我做一个记忆系统", "我先问清了它要记什么 keptmark4v。");
  const f2 = remember(s, t0, a, "用户纠正了我的理解", "他说要记的是经历。");
  const f3 = remember(s, t0, b, "另一次我也先问清了需求", "用户说这样省了返工。");
  const erased = remember(s, t0, b, "用户告诉我一件私事", "住址是 qx4private7k 路。");
  rememberWith(s, { sessionId: a, source: "reconstructed", gist: "半年前的一个项目", body: "从记录里整理的。", happened: t0 - 180 * 24 * hour });
  const fixed = s.correct(t0, f2, {
    sessionId: a, moment: "other", source: "lived", importance: 0.5, gist: "用户纠正了我对记忆系统的理解", body: "他说要记的是经历。",
  });
  s.erase(t0, b, erased, "the user asked");
  s.addPreference(t0, a, "不用记天气之类的闲聊", 30);
  reflectOn(s, a, [
    ent("episode", "把方向定了下来", f1, fixed),
    { ...ent("impression", "说话直接", fixed), about: "用户" },
    entry({ kind: "self", gist: "我动手前会先问清楚", context: "做设计的时候", importance: 0.5, from: [f1, fixed, f3] }),
  ], f3);
  amend(s, a, "pin", f3);
  listed(s, f3);
  read(s, f3);
  s.setTokenHash("tokenhash");
}

describe("check", () => {
  it("CheckOfAMemoryInGoodOrder", () =>
    withStore((s) => {
      life(s);
      const r = s.check();
      expect(countFindings(r, LevelProblem) + countFindings(r, LevelWarning), reportText(r)).toBe(0);
      const out = reportText(r);
      for (const want of [
        "log: format 3, 17 events: 2 sessions, 9 memories written, 1 listings, 1 readings, 2 amendments, 1 rounds of reflection, 1 erased, 0 restores",
        "memories: 4 standing (1 core, 3 active, 0 faded, 0 archived), 4 set aside or part of another; the clock reads 4",
        "by source: lived 4, reconstructed 1",
        "about yourself: 1 statements stand, 0 earlier versions kept",
        "preferences: 1 in force, 0 retired",
        "waiting for reflect: 1",
        "problems: none",
        "warnings: none",
        "  [never-came-to-mind] 3 of 4 standing memories have never been listed or read since they were written",
      ]) {
        expect(out, want).toContain(want);
      }
      expect(figure(r, "by kind").split(", ").sort()).toEqual(["episode 1", "fragment 2", "impression 1"]);
      // It names memories by id and never says what one says.
      for (const text of ["记忆系统", "keptmark4v", "问清", "天气", "用户", "说话直接", "住址", "做设计"]) {
        expect(out, "the report quotes a memory").not.toContain(text);
      }
    }));

  // There is no log-only open on this platform: the derived tables are built
  // when the object starts. A memory without them is made by dropping one.
  it("CheckOfAMemoryNotBuilt", () =>
    withStore((s, storage) => {
      life(s);
      storage.sql.exec(`DROP TABLE memories`);
      const r = s.check();
      found(r, LevelNote, "not-built");
      expect(r.findings).toHaveLength(1);
      expect(r.figures.map((f) => f.name)).toEqual(["log"]);
    }));

  it("CheckFindsADamagedRecord", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const lost = remember(s, t0, sess, "会丢正文的记忆", "正文一");
      const altered = remember(s, t0, sess, "正文被改的记忆", "正文二");
      const gone = remember(s, t0, sess, "被删除的记忆", "正文三");
      const stays = remember(s, t0, sess, "删了但正文还在的记忆", "正文四");
      s.erase(t0, sess, gone, "");
      // Do to the database what the store itself never does.
      for (const stmt of [
        `DELETE FROM contents WHERE id = '${lost}'`,
        `DROP TRIGGER contents_no_update`,
        `UPDATE contents SET data = replace(data, '正文二', '别的话') WHERE id = '${altered}'`,
        `INSERT INTO contents(id, data) VALUES('m_nobody', '{"gist":"x"}')`,
        `DROP TRIGGER events_no_update`,
        `UPDATE events SET kind = 'erase', payload = '{"session":"${sess}","id":"${stays}"}' WHERE kind = 'erase'`,
        `INSERT INTO events(at, kind, payload) VALUES(1, 'remember', '{"id":"m_stray","session":"s_nobody","moment":"other","source":"lived","importance":0.5,"hash":""}')`,
        `INSERT INTO links(src, dst) VALUES('${lost}', 'm_missing')`,
        `UPDATE memories SET ord = ord + 7 WHERE id = '${stays}'`,
      ]) {
        storage.sql.exec(stmt);
      }
      const r = s.check();
      expect(found(r, LevelProblem, "content-lost").ids.sort()).toEqual([lost, gone, "m_stray"].sort());
      expect(found(r, LevelProblem, "content-altered").ids).toEqual([altered]);
      expect(found(r, LevelProblem, "erase-incomplete").ids).toEqual([stays]);
      expect(found(r, LevelProblem, "content-orphaned").text).toBe("1 pieces of content belong to no memory in the log");
      expect(found(r, LevelProblem, "session-unknown").ids).toEqual(["m_stray"]);
      expect(found(r, LevelProblem, "tables-stale").text).toBe("the tables hold 4 memories and the log 5: run rebuild");
      expect(found(r, LevelProblem, "clock-off").text)
        .toBe("the experience clock reads 4 and the log holds 5 moments written as they happened: run rebuild");
      expect(found(r, LevelProblem, "link-broken").ids).toContain(lost);
    }));

  it("CheckFlagsUseThatWillNotServe", () =>
    withStore((s) => {
      const busy = session(s, t0, "", "cli");
      const quiet = session(s, t0, "", "cli");
      let code = "", twinA = "", twinB = "";
      for (let i = 0; i < 60; i++) {
        const input = { sessionId: busy, gist: `第 ${i} 件事`, body: `正文 ${i}`, importance: 0.5, feeling: "", intensity: 0 };
        if (i < 25) input.importance = 0.95; // most things marked as never to fade
        else if (i < 45) Object.assign(input, { feeling: "震动", intensity: 0.95 }); // and most things felt to the utmost
        else if (i === 45) input.body = "改法如下：\n```go\nfunc main() {}\n```";
        else if (i === 46 || i === 47) input.gist = "一模一样的梗概";
        const id = rememberWith(s, input);
        if (i === 45) code = id;
        if (i === 46) twinA = id;
        if (i === 47) twinB = id;
      }
      const a = remember(s, t0, quiet, "另一段对话里的事", "正文");
      const long = rememberWith(s, { sessionId: quiet, gist: "一段很长的记录", body: "字".repeat(3001) });
      const b = rememberWith(s, { sessionId: busy, gist: "在场的经历一", body: "正文" });
      const c = rememberWith(s, { sessionId: busy, gist: "在场的经历二", body: "正文" });
      const [self] = reflectOn(s, quiet, [
        entry({ kind: "self", gist: "一句自述", importance: 0.5, from: [a, b, c] }),
        { ...ent("impression", "印象一", a), about: "Alex" },
        { ...ent("impression", "印象二", b), about: "alex " },
        // Not in Go: two impressions under the same name are one thing, not
        // two names; the second replaces the first.
        { ...ent("impression", "印象三", c), about: "Bo" },
        { ...ent("impression", "印象四", c), about: "Bo" },
      ]);
      amend(s, quiet, "retract", b);

      const r = s.check();
      expect(countFindings(r, LevelProblem), reportText(r)).toBe(0);
      expect(found(r, LevelWarning, "many-writes").ids).toEqual([`${busy} (62)`]);
      expect(found(r, LevelWarning, "core-inflated").text)
        .toBe("45 of 66 standing memories never fade; if most things are kept for good, importance says little");
      expect(found(r, LevelWarning, "feeling-inflated").text)
        .toBe("20 of 64 moments were felt at 0.9 or above; a feeling is for what actually registered");
      expect(found(r, LevelWarning, "looks-like-project-notes").ids).toEqual([code, long]);
      expect(found(r, LevelWarning, "same-gist").ids).toEqual([twinA, twinB]);
      expect(found(r, LevelWarning, "self-unsupported").ids).toEqual([self]);
      expect(found(r, LevelWarning, "backlog").text).toBe("63 moments have not been reflected on");
      expect(found(r, LevelNote, "name-variants").text)
        .toBe("1 people or things have impressions under names that differ only in case or spacing, so they count as different");
      found(r, LevelNote, "never-came-to-mind");
      const out = reportText(r);
      for (const text of ["一模一样", "Alex", "func main"]) expect(out, "the report quotes a memory").not.toContain(text);
    }));

  // Not in check_test.go: the findings it does not reach, and the two ways
  // the clock can be off on this platform.
  it("CheckFindsTheRest", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const old = remember(s, t0, sess, "旧的", "正文");
      const fixed = s.correct(t0, old, { sessionId: sess, moment: "other", source: "lived", importance: 0.5, gist: "新的", body: "正文" });
      // Restoring from an export is a later stage: its event is written by hand.
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'restore', ?)`, t0 + hour,
        `{"from":"i_aaaaaaaa","exported_at":${t0},"events":3}`);
      s.rebuild();
      let r = s.check();
      expect(countFindings(r, LevelProblem) + countFindings(r, LevelWarning), reportText(r)).toBe(0);
      expect(found(r, LevelNote, "restored").text)
        .toBe("this memory was brought back from an export 1 time(s); what was lived between an export and its restore is not in it");

      amend(s, sess, "retract", fixed);
      // One vector, of memory 9999 (0x270f, little-endian), which does not exist.
      storage.sql.exec(`INSERT INTO vector_rows(model, dims, count, ns, vecs) VALUES('m', 1, 1, x'0f270000', x'7f')`);
      r = s.check();
      expect(found(r, LevelWarning, "nothing-in-its-place").ids).toEqual([old]);
      expect(found(r, LevelNote, "vector-orphaned").text).toBe("1 embeddings belong to no memory");
      // A rebuild drops it.
      s.rebuild();
      expect(s.check().findings.map((x) => x.code)).not.toContain("vector-orphaned");
      expect(storage.sql.exec(`SELECT count(*) AS c FROM vector_rows`).one().c).toBe(0);
      storage.sql.exec(`INSERT INTO vector_rows(model, dims, count, ns, vecs) VALUES('m', 1, 1, x'0f270000', x'7f')`);

      // The clock in meta is what every read uses; the largest ord must agree.
      storage.sql.exec(`UPDATE meta SET value = '5' WHERE key = 'clock'`);
      expect(found(s.check(), LevelProblem, "clock-off").text)
        .toBe("the experience clock reads 5 and the log holds 1 moments written as they happened: run rebuild");
      storage.sql.exec(`UPDATE meta SET value = '1' WHERE key = 'clock'`);
      expect(s.check().findings.map((f) => f.code)).not.toContain("clock-off");
      storage.sql.exec(`UPDATE memories SET ord = 3 WHERE id = ?`, old);
      expect(found(s.check(), LevelProblem, "clock-off").text)
        .toBe("the experience clock reads 3 and the log holds 1 moments written as they happened: run rebuild");
    }));

  it("CheckCountsTheBacklogFromFifty", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      for (let i = 0; i < 49; i++) remember(s, t0, sess, `第 ${i} 件`, "正文");
      expect(figure(s.check(), "waiting for reflect")).toBe("49");
      remember(s, t0, sess, "第 49 件", "正文");
      const r = s.check();
      expect(found(r, LevelWarning, "backlog").text).toBe("50 moments have not been reflected on");
      expect(r.figures.map((x) => x.name)).not.toContain("waiting for reflect");
    }));

  it("CheckNamesAtMostTwentyIds", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const written: string[] = [];
      for (let i = 0; i < 25; i++) written.push(remember(s, t0, sess, `第 ${i} 件`, "正文"));
      storage.sql.exec(`DELETE FROM contents WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(written.slice(0, 20)));
      expect(found(s.check(), LevelProblem, "content-lost").ids).toEqual(written.slice(0, 20));
      storage.sql.exec(`DELETE FROM contents WHERE id = ?`, written[20]);
      expect(found(s.check(), LevelProblem, "content-lost").ids).toEqual([...written.slice(0, 20), "and 1 more"]);
      storage.sql.exec(`DELETE FROM contents`);
      const f = found(s.check(), LevelProblem, "content-lost");
      expect(f.ids).toEqual([...written.slice(0, 20), "and 5 more"]);
      expect(f.text).toBe("25 memories have lost what they said, and the log holds no erasure for them");
    }));
});
