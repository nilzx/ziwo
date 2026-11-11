// Checks that are new on this platform: the stored forms must be byte for
// byte what the Go build wrote, and the log format is guarded. The expected
// strings were produced by Go's encoding/json and encoding/base32 (Go 1.27).

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeContent } from "../src/store/content";
import { encodeRecall, encodeRemember, type RememberEvent } from "../src/store/events";
import { encodeID, newID } from "../src/store/ids";
import { LogFormatError, ReplayError, Store } from "../src/store/store";
import { dump, freshObject, inObject, populate, session, testParams, withStore } from "./helpers";

const remember = (e: Partial<RememberEvent>): RememberEvent => ({
  id: "", session: "", kind: "", moment: "", source: "", importance: 0, intensity: 0, hash: "",
  corrects: "", happened: 0, from: [], ref: "", milestone: false, ...e,
});

describe("stored forms match the Go build", () => {
  it("content", () => {
    const c = encodeContent({
      gist: "a<b>&c \u2028\u2029 \"q\" \\ \t\n\r\b\f\x01\x1f\x7f 猫",
      body: "x",
      outcome: "",
      people: ["年糕", "<p>"],
      pointer: "https://example.com/?a=1&b=2",
    });
    expect(c.data).toBe(
      String.raw`{"gist":"a\u003cb\u003e\u0026c \u2028\u2029 \"q\" \\ \t\n\r\b\f\u0001\u001f` +
        "\x7f" +
        String.raw` 猫","body":"x","people":["年糕","\u003cp\u003e"],"pointer":"https://example.com/?a=1\u0026b=2"}`,
    );
    expect(c.hash).toBe("45855bed5cabc4b98dd56f34f8823c566cba3055fd6673bdccc38d0cfc641152");
    expect(encodeContent({ gist: "only", people: [] }).data).toBe(`{"gist":"only"}`);
  });

  it("events", () => {
    expect(
      encodeRemember(remember({
        id: "m_abcdefgh", session: "s_abcdefgh", kind: "episode", moment: "other", source: "lived",
        importance: 0.3, intensity: 1e-7, hash: "h", happened: 1762848000000, from: ["m_1", "m_2"], milestone: true,
      })),
    ).toBe(
      `{"id":"m_abcdefgh","session":"s_abcdefgh","kind":"episode","moment":"other","source":"lived","importance":0.3,"intensity":1e-7,"hash":"h","happened":1762848000000,"from":["m_1","m_2"],"milestone":true}`,
    );
    expect(
      encodeRemember(remember({ id: "m_x", session: "s_x", moment: "other", source: "lived", importance: 1, intensity: 1e21, hash: "h" })),
    ).toBe(`{"id":"m_x","session":"s_x","moment":"other","source":"lived","importance":1,"intensity":1e+21,"hash":"h"}`);
    expect(encodeRemember(remember({ id: "m_x", session: "s_x", importance: 0.000001, intensity: 123456789.125 }))).toBe(
      `{"id":"m_x","session":"s_x","moment":"","source":"","importance":0.000001,"intensity":123456789.125,"hash":""}`,
    );
    expect(encodeRecall({ session: "", query: "<q>&", ids: [], clock: 0 })).toBe(`{"query":"\\u003cq\\u003e\\u0026","ids":[]}`);
  });

  it("ids", () => {
    expect(encodeID(Uint8Array.from([0, 1, 2, 3, 4]))).toBe("aaasea2e");
    expect(encodeID(Uint8Array.from([255, 254, 253, 252, 251]))).toBe("999r59h5");
    expect(encodeID(Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a]))).toBe("ci4fn8e4");
    for (let i = 0; i < 200; i++) expect(newID("m_")).toMatch(/^m_[a-km-np-z2-9]{8}$/);
  });

  it("ids handed out by the store", () =>
    withStore((s) => {
      const { session } = s.startSession(1, "", "");
      expect(session.id).toMatch(/^s_[a-km-np-z2-9]{8}$/);
      expect(s.remember(1, { sessionId: session.id, moment: "other", source: "lived", importance: 0.5, gist: "g", body: "b" }).id)
        .toMatch(/^m_[a-km-np-z2-9]{8}$/);
    }));
});

describe("log format", () => {
  it("is recorded as 3 in a new memory", () =>
    withStore((_s, storage) => {
      expect(storage.sql.exec(`SELECT value FROM meta WHERE key = 'log_format'`).one().value).toBe("3");
      expect(String(storage.sql.exec(`SELECT value FROM meta WHERE key = 'instance'`).one().value)).toMatch(/^i_[a-km-np-z2-9]{8}$/);
    }));

  it("refuses a newer log, and an older one it does not migrate", () =>
    withStore((_s, storage) => {
      const open = (format: string | null): unknown => {
        if (format === null) storage.sql.exec(`DELETE FROM meta WHERE key = 'log_format'`);
        else storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'log_format'`, format);
        try {
          new Store(storage);
          return undefined;
        } catch (err) {
          return err;
        }
      };
      const newer = open("4");
      expect(newer).toBeInstanceOf(LogFormatError);
      expect((newer as LogFormatError).newer).toBe(true);
      expect((newer as Error).message).toMatch(/written by a newer version of ziwo/);
      const older = open("2");
      expect(older).toBeInstanceOf(LogFormatError);
      expect((older as LogFormatError).newer).toBe(false);
      expect(open("3")).toBeUndefined();

      // A log with events and no recorded format predates versioning.
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(1, 'session', '{"id":"s_aaaaaaaa"}')`);
      const unversioned = open(null);
      expect(unversioned).toBeInstanceOf(LogFormatError);
      expect((unversioned as LogFormatError).format).toBe(0);
    }));

  it("refuses to project an unknown kind of event", () =>
    withStore((s, storage) => {
      session(s, 1, "", "");
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(1, 'bogus', '{}')`);
      expect(() => s.rebuild()).toThrow(/replay event 2: unknown event kind "bogus"/);
      expect(s.counts()).toEqual({ memories: 0, events: 2 });
    }));
});

// On this platform a failed replay must not have created the keyword index in
// the transaction it rolls back: that resets the object instead of throwing.
describe("rebuilding", () => {
  it("changes nothing when an event part-way cannot be applied, and the memory stays usable", async () => {
    const stub = freshObject();
    const before = await inObject(stub, (s, storage) => {
      s.setParams(testParams());
      populate(s);
      const d = dump(s, storage);
      // Last in the log, so everything before it is replayed first.
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(1, 'remember', 'not json')`);
      expect(() => s.rebuild()).toThrow(ReplayError);
      expect(dump(s, storage)).toBe(d);
      expect(() => s.setParams({ ...testParams(), baseStrength: 20 })).toThrow(ReplayError);
      expect(s.params()).toEqual(testParams());
      return d;
    });
    // A later call reaches the same object and finds everything where it was.
    expect(await inObject(stub, (s, storage) => dump(s, storage))).toBe(before);
  });

  it("creates the keyword index again and refills it when its definition changes", async () => {
    const stub = freshObject();
    const before = await inObject(stub, (s, storage) => {
      s.setParams(testParams());
      populate(s);
      const d = dump(s, storage);
      // Stand in for an index made by an older definition.
      storage.sql.exec(`DROP TABLE memories_fts`);
      storage.sql.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(old_layout)`);
      storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'index'`);
      return d;
    });
    await evictDurableObject(stub);
    const after = await inObject(stub, (s, storage) => ({
      dump: dump(s, storage),
      version: storage.sql.exec(`SELECT value FROM meta WHERE key = 'index'`).one().value,
    }));
    expect(after.dump).toBe(before);
    expect(after.version).toBe("1");
  });
});
