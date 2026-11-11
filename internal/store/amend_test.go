package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// replays checks that the derived tables are what replaying the log gives.
func replays(t *testing.T, s *Store) {
	t.Helper()
	before := dump(t, s)
	if err := s.Rebuild(context.Background()); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if after := dump(t, s); after != before {
		t.Errorf("replaying the log gives a different memory\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

func amend(t *testing.T, s *Store, sess, action, id string, importance float64) {
	t.Helper()
	if err := s.Amend(context.Background(), t0, sess, action, id, importance, "the user asked"); err != nil {
		t.Fatalf("%s %s: %v", action, id, err)
	}
}

func recentIDs(t *testing.T, s *Store) []string {
	t.Helper()
	ms, err := s.Recent(context.Background(), clock(t, s), 100)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, m := range ms {
		out = append(out, m.ID)
	}
	return out
}

func has(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestWhatAMemorySaysIsNotInItsEvent(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	var payload, data string
	if err := s.r.QueryRow(`SELECT payload FROM events WHERE kind = 'remember'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "猫") || strings.Contains(payload, "年糕") {
		t.Errorf("the event holds what the memory says: %s", payload)
	}
	if err := s.r.QueryRow(`SELECT data FROM contents WHERE id = ?`, id).Scan(&data); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(data))
	if !strings.Contains(payload, `"hash":"`+hex.EncodeToString(sum[:])+`"`) {
		t.Errorf("the event does not carry the hash of the content: %s", payload)
	}
	if _, err := s.w.Exec(`UPDATE contents SET data = '{}'`); err == nil || !strings.Contains(err.Error(), "written once") {
		t.Errorf("content could be rewritten: %v", err)
	}
	if m := get(t, s, id); m.Body != "一只橘猫，名字叫年糕。" || m.Kind != KindFragment || !m.Live() || !m.Pending {
		t.Errorf("memory read back: %+v", m)
	}
}

// A file as the previous release wrote it: format 1, with the text of each
// memory inside its event.
func TestFormat1LogIsUpgraded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.ziwo")
	raw, err := sql.Open("sqlite3", fileURI(path)+"?mode=rwc")
	if err != nil {
		t.Fatal(err)
	}
	at := t0.UnixMilli()
	if _, err := raw.Exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
		CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
		INSERT INTO meta VALUES ('log_format', '1');
		INSERT INTO events(at, kind, payload) VALUES
		 (?1, 'session', '{"id":"s_aaaaaaaa","model":"model-old","client":"cli"}'),
		 (?1, 'remember', '{"id":"m_aaaaaaaa","session":"s_aaaaaaaa","moment":"corrected","source":"lived","importance":0.6,"gist":"用户纠正了我","body":"我理解偏了 zq7secret9x。","outcome":"改了设计","lesson":"先问清楚","people":["用户"],"pointer":"https://example.com/x"}'),
		 (?1, 'remember', '{"id":"m_bbbbbbbb","session":"s_aaaaaaaa","moment":"other","source":"told","importance":0.5,"intensity":0.95,"gist":"The user said the deploy had failed","body":"He told me the proxy rejected it.","feeling":"struck"}'),
		 (?1, 'recall', '{"session":"s_aaaaaaaa","query":"纠正","ids":["m_aaaaaaaa"]}'),
		 (?1, 'expand', '{"session":"s_aaaaaaaa","ids":["m_aaaaaaaa"]}')`, at); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	s := open(t, path)
	a, b := get(t, s, "m_aaaaaaaa"), get(t, s, "m_bbbbbbbb")
	if a.Gist != "用户纠正了我" || a.Body != "我理解偏了 zq7secret9x。" || a.Outcome != "改了设计" || a.Lesson != "先问清楚" ||
		!reflect.DeepEqual(a.People, []string{"用户"}) || a.Pointer != "https://example.com/x" || a.Moment != "corrected" ||
		a.Importance != 0.6 || a.Model != "model-old" || a.RecallCount != 2 {
		t.Errorf("first memory after the upgrade: %+v", a)
	}
	if b.Feeling != "struck" || b.Intensity != 0.95 || !b.Core || b.Source != "told" {
		t.Errorf("second memory after the upgrade: %+v", b)
	}
	var withText, contents int
	if err := s.r.QueryRow(`SELECT (SELECT count(*) FROM events WHERE kind = 'remember' AND (payload LIKE '%gist%' OR payload LIKE '%zq7secret9x%' OR payload NOT LIKE '%"hash":"%')),
		(SELECT count(*) FROM contents)`).Scan(&withText, &contents); err != nil {
		t.Fatal(err)
	}
	if withText != 0 || contents != 2 {
		t.Errorf("after the upgrade %d events still hold text and contents has %d rows; want 0 and 2", withText, contents)
	}
	if got := searchIDs(t, s, "纠正"); !reflect.DeepEqual(got, []string{"m_aaaaaaaa"}) {
		t.Errorf("search after the upgrade: %v", got)
	}
	if _, err := s.w.Exec(`DELETE FROM events`); err == nil {
		t.Error("the upgrade left the log deletable")
	}
	replays(t, s)

	// What could not be erased before can be now, and leaves the file.
	if _, err := s.Erase(context.Background(), t0, "s_aaaaaaaa", "m_aaaaaaaa", ""); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if v, _ := metaValue(t, path, metaLogFormat); v != "2" {
		t.Errorf("log format = %q, want 2", v)
	}
	if data, _ := os.ReadFile(path); bytes.Contains(data, []byte("zq7secret9x")) || bytes.Contains(data, []byte("我理解偏了")) {
		t.Error("the upgraded file still holds the erased text")
	}
}

func TestEraseDeletesWhatAMemorySaysForGood(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	ctx := context.Background()
	s := open(t, path)
	sess := session(t, s, t0, "", "cli")
	keep := remember(t, s, t0, sess.ID, "用户问了天气", "聊了几句。")
	gone := rememberWith(t, s, RememberInput{SessionID: sess.ID, Gist: "用户告诉我一件私事 qx4gistmark", Body: "他说了地址 zq7secret9x，后来让我删掉。",
		Outcome: "outcomemark5k", Lesson: "lessonmark8w", People: []string{"peoplemark2j"}, Pointer: "pointermark6h"})
	n := get(t, s, gone).N
	if err := s.SaveVector(ctx, n, "model-x", []float32{1, 2}); err != nil {
		t.Fatal(err)
	}
	fill(t, s, sess.ID, 3)

	got, err := s.Erase(ctx, t0.Add(time.Hour), sess.ID, gone, "the user asked me to delete it")
	if err != nil || got != n {
		t.Fatalf("erase: n=%d err=%v, want %d", got, err, n)
	}
	m := get(t, s, gone)
	if m.State != StateErased || m.Live() || m.Gist != "" || m.Body != "" || m.Outcome != "" || m.Lesson != "" || len(m.People) != 0 || m.Pointer != "" {
		t.Errorf("after erase: %+v", m)
	}
	// It was lived through: it keeps its place, and the clock does not move.
	if m.Ord != 2 || clock(t, s) != 5 || !m.CreatedAt.Equal(t0) {
		t.Errorf("after erase: ord %d, clock %d, created %v; want 2, 5, unchanged", m.Ord, clock(t, s), m.CreatedAt)
	}
	for _, q := range []string{"私事", "地址", "zq7secret9x", "qx4gistmark"} {
		if ids := search(t, s, q, true); len(ids) != 0 {
			t.Errorf("deep search for %q still finds %v", q, ids)
		}
	}
	if has(recentIDs(t, s), gone) || !has(recentIDs(t, s), keep) {
		t.Errorf("recent after erase: %v", recentIDs(t, s))
	}
	if c, _ := s.TierCounts(ctx, clock(t, s)); c.Total() != 4 {
		t.Errorf("counts after erase: %+v, want 4 live memories", c)
	}
	left := 0
	_ = s.Vectors(ctx, "model-x", func(int64, []float32) error { left++; return nil })
	if left != 0 {
		t.Errorf("%d vectors left for the erased memory", left)
	}
	// The log says that it existed and that it was erased, and why.
	var reason string
	if err := s.r.QueryRow(`SELECT json_extract(payload, '$.reason') FROM events WHERE kind = 'erase'`).Scan(&reason); err != nil || reason != "the user asked me to delete it" {
		t.Errorf("erase event: reason %q, err %v", reason, err)
	}
	replays(t, s)

	// There is nothing left to erase or amend.
	if _, err := s.Erase(ctx, t0, sess.ID, gone, ""); !errors.Is(err, ErrErased) {
		t.Errorf("second erase: %v, want %v", err, ErrErased)
	}
	if err := s.Amend(ctx, t0, sess.ID, AmendPin, gone, 0, ""); !errors.Is(err, ErrErased) {
		t.Errorf("pin of an erased memory: %v", err)
	}
	if _, err := s.Erase(ctx, t0, sess.ID, "m_nothing", ""); !errors.Is(err, ErrNoMemory) {
		t.Errorf("erase of nothing: %v", err)
	}
	if _, err := s.Erase(ctx, t0, "s_nothing", keep, ""); !errors.Is(err, ErrNoSession) {
		t.Errorf("erase without a session: %v", err)
	}

	// Not a byte of it is left in the file, the keyword index included.
	s.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, mark := range []string{"zq7secret9x", "qx4gistmark", "outcomemark5k", "lessonmark8w", "peoplemark2j", "pointermark6h", "私事", "地址"} {
		if bytes.Contains(data, []byte(mark)) {
			t.Errorf("the file still contains %q", mark)
		}
	}
	if !bytes.Contains(data, []byte("天气")) {
		t.Error("the check is not looking at the text: a kept memory is not found in the file either")
	}
	if extra, _ := filepath.Glob(path + "-*"); len(extra) != 0 {
		t.Errorf("files left beside the memory: %v", extra)
	}

	// A file without the content replays to the same thing.
	s2 := open(t, path)
	if m := get(t, s2, gone); m.State != StateErased || m.Ord != 2 {
		t.Errorf("after reopening: %+v", m)
	}
	replays(t, s2)
}

func TestRetractSetsAsideAndRestoreBringsBack(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")
	fill(t, s, sess.ID, 2)

	amend(t, s, sess.ID, AmendRetract, id, 0)
	if m := get(t, s, id); !m.Retracted || m.Live() || m.Body == "" {
		t.Errorf("after retract: %+v; want it set aside with its text kept", m)
	}
	for _, deep := range []bool{false, true} {
		if ids := search(t, s, "年糕", deep); len(ids) != 0 {
			t.Errorf("a retracted memory was found (deep=%v): %v", deep, ids)
		}
	}
	if has(recentIDs(t, s), id) {
		t.Error("a retracted memory is listed as recent")
	}
	if c, _ := s.TierCounts(ctx, clock(t, s)); c.Total() != 2 {
		t.Errorf("counts with one retracted: %+v", c)
	}
	replays(t, s)

	fill(t, s, sess.ID, 20)
	amend(t, s, sess.ID, AmendRestore, id, 0)
	// Restored, it is within reach again: being amended is coming to mind.
	if m := get(t, s, id); m.Retracted || m.TouchedOrd != 23 || m.Tier(clock(t, s)) != TierActive || m.Strength != 10 {
		t.Errorf("after restore: retracted %v, touched %d, tier %s, strength %v", m.Retracted, m.TouchedOrd, m.Tier(clock(t, s)), m.Strength)
	}
	if ids := searchIDs(t, s, "年糕"); !reflect.DeepEqual(ids, []string{id}) {
		t.Errorf("after restore: %v", ids)
	}
	replays(t, s)
}

func TestPinAndReweigh(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	pinned := remember(t, s, t0, sess.ID, "要记牢的事", "正文")
	light := remember(t, s, t0, sess.ID, "没那么重要的事", "正文")
	heavy := remember(t, s, t0, sess.ID, "后来才知道重要的事", "正文")

	amend(t, s, sess.ID, AmendPin, pinned, 0)
	amend(t, s, sess.ID, AmendReweigh, light, 0.25) // half the importance: half the strength
	amend(t, s, sess.ID, AmendReweigh, heavy, 0.9)  // over the core threshold
	fill(t, s, sess.ID, 60)
	now := clock(t, s)

	if m := get(t, s, pinned); !m.Pinned || !m.Core || m.Tier(now) != TierCore || m.FadeAt != 0 {
		t.Errorf("pinned: %+v", m)
	}
	if m := get(t, s, light); m.Importance != 0.25 || !near(m.Strength, 5, 1e-9) || m.Tier(now) != TierArchived {
		t.Errorf("made lighter: importance %v, strength %v, tier %s; want 0.25, 5, archived", m.Importance, m.Strength, m.Tier(now))
	}
	if m := get(t, s, heavy); m.Importance != 0.9 || !m.Core || !near(m.Strength, 10*math.Pow(4, 0.8), 1e-9) {
		t.Errorf("made heavier: importance %v, core %v, strength %v", m.Importance, m.Core, m.Strength)
	}
	core, _ := s.Core(ctx, 10)
	if len(core) != 2 || core[0].ID != pinned {
		t.Errorf("core list: %d memories, want the pinned one first of two", len(core))
	}
	replays(t, s)

	// Unpinned, it fades like any other memory from here on.
	amend(t, s, sess.ID, AmendUnpin, pinned, 0)
	if m := get(t, s, pinned); m.Pinned || m.Core || m.TouchedOrd != now || m.Tier(now) != TierActive {
		t.Errorf("unpinned: %+v", m)
	}
	fill(t, s, sess.ID, 13)
	if got := get(t, s, pinned).Tier(clock(t, s)); got != TierFaded {
		t.Errorf("13 memories after being unpinned: %s, want faded", got)
	}
	// Brought back under the threshold, the other one fades again too.
	amend(t, s, sess.ID, AmendReweigh, heavy, 0.5)
	if m := get(t, s, heavy); m.Core || !near(m.Strength, 10, 1e-9) {
		t.Errorf("back to ordinary: core %v, strength %v", m.Core, m.Strength)
	}

	for name, err := range map[string]error{
		"unknown memory":  s.Amend(ctx, t0, sess.ID, AmendPin, "m_nothing", 0, ""),
		"unknown session": s.Amend(ctx, t0, "s_nothing", AmendPin, pinned, 0, ""),
		"unknown action":  s.Amend(ctx, t0, sess.ID, "polish", pinned, 0, ""),
	} {
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if !errors.Is(s.Amend(ctx, t0, sess.ID, AmendPin, "m_nothing", 0, ""), ErrNoMemory) {
		t.Error("an unknown memory is not reported as such")
	}
	replays(t, s)
}

func TestCorrectionReplacesWithoutRewriting(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "model-a", "cli")
	old := remember(t, s, t0, sess.ID, "用户的猫叫年糕", "一只橘猫。")
	fill(t, s, sess.ID, 4)
	later := session(t, s, t0.Add(48*time.Hour), "model-b", "desktop")

	id, err := s.Correct(ctx, t0.Add(48*time.Hour), old, RememberInput{SessionID: later.ID, Moment: "other", Source: "lived",
		Importance: 0.5, Gist: "用户的猫叫汤圆", Body: "一只橘猫。我之前记成了年糕。", Happened: t0})
	if err != nil {
		t.Fatal(err)
	}
	was, is := get(t, s, old), get(t, s, id)
	if was.State != StateSuperseded || was.StateBy != id || was.Live() || was.Gist != "用户的猫叫年糕" {
		t.Errorf("the old memory: %+v; want it kept as it was, marked as replaced", was)
	}
	if !is.Live() || is.Corrects != old || is.Kind != KindFragment || is.Model != "model-b" ||
		!is.CreatedAt.Equal(t0) || !is.WrittenAt.Equal(t0.Add(48*time.Hour)) {
		t.Errorf("the correction: %+v", is)
	}
	// A correction adds nothing to what was lived through.
	if clock(t, s) != 5 || is.Ord != 5 || is.TouchedOrd != 5 {
		t.Errorf("clock %d, correction at ord %d; want 5 and 5: a correction must not push other memories away", clock(t, s), is.Ord)
	}
	if got := searchIDs(t, s, "橘猫"); !reflect.DeepEqual(got, []string{id}) {
		t.Errorf("ordinary search finds %v, want only the correction", got)
	}
	if got := search(t, s, "橘猫", true); len(got) != 2 {
		t.Errorf("deep search finds %v, want both versions", got)
	}
	if has(recentIDs(t, s), old) {
		t.Error("the replaced memory is listed as recent")
	}
	replays(t, s)

	if _, err := s.Correct(ctx, t0, old, RememberInput{SessionID: sess.ID, Gist: "g", Body: "b"}); !errors.Is(err, ErrSuperseded) || !strings.Contains(err.Error(), id) {
		t.Errorf("correcting what was already replaced: %v, want it to point at %s", err, id)
	}
	if _, err := s.Correct(ctx, t0, "m_nothing", RememberInput{SessionID: sess.ID, Gist: "g", Body: "b"}); !errors.Is(err, ErrNoMemory) {
		t.Errorf("correcting nothing: %v", err)
	}
	// The correction can be corrected in turn.
	again, err := s.Correct(ctx, t0, id, RememberInput{SessionID: sess.ID, Moment: "other", Source: "lived", Importance: 0.5, Gist: "用户的猫叫元宵", Body: "一只橘猫。"})
	if err != nil || get(t, s, id).StateBy != again || get(t, s, old).StateBy != id {
		t.Errorf("second correction: %v", err)
	}
}

func TestPreferences(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")

	a, err := s.AddPreference(ctx, t0, sess.ID, "不用记天气之类的闲聊", 2)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.AddPreference(ctx, t0.Add(time.Minute), sess.ID, "用户改主意的时候要记", 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPreference(ctx, t0, sess.ID, "第三条", 2); !errors.Is(err, ErrTooManyPreferences) {
		t.Errorf("a third preference with room for two: %v", err)
	}
	if _, err := s.AddPreference(ctx, t0, "s_nothing", "x", 2); !errors.Is(err, ErrNoSession) {
		t.Errorf("a preference without a session: %v", err)
	}
	ps, _ := s.Preferences(ctx)
	if len(ps) != 2 || ps[0].ID != a || ps[0].Text != "不用记天气之类的闲聊" || ps[1].ID != b {
		t.Errorf("preferences: %+v", ps)
	}
	if clock(t, s) != 0 {
		t.Error("a preference advanced the clock")
	}

	if err := s.RetirePreference(ctx, t0.Add(time.Hour), sess.ID, a, "the user changed their mind"); err != nil {
		t.Fatal(err)
	}
	if err := s.RetirePreference(ctx, t0, sess.ID, a, ""); !errors.Is(err, ErrNoPreference) {
		t.Errorf("retiring it twice: %v", err)
	}
	if ps, _ := s.Preferences(ctx); len(ps) != 1 || ps[0].ID != b {
		t.Errorf("after retiring one: %+v", ps)
	}
	// Room again.
	if _, err := s.AddPreference(ctx, t0, sess.ID, "第三条", 2); err != nil {
		t.Errorf("after retiring one there is room: %v", err)
	}
	replays(t, s)
}

// Only a moment written as it happens moves the clock. What is written about
// the past afterwards does not push other memories away.
func TestReconstructedMemoriesDoNotMoveTheClock(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	lived := remember(t, s, t0, sess.ID, "今天发生的事", "正文")
	fill(t, s, sess.ID, 4) // clock 5

	// Four hundred accounts of the past, written in one go.
	var first, last string
	for i := 0; i < 400; i++ {
		when := t0.AddDate(0, 0, -400+i)
		id, dup, err := s.Remember(ctx, t0, RememberInput{SessionID: sess.ID, Moment: "other", Source: SourceReconstructed,
			Importance: 0.5, Gist: "旧会话 " + when.Format(time.DateOnly), Body: "从记录里整理出来的。", Happened: when})
		if err != nil || dup {
			t.Fatalf("reconstructed %d: err=%v dup=%v", i, err, dup)
		}
		if i == 0 {
			first = id
		}
		last = id
	}
	now := clock(t, s)
	if now != 5 {
		t.Fatalf("clock = %d, want 5: reconstructed memories must not advance it", now)
	}
	// Nothing that was there has been pushed away, and none of the new ones
	// arrived already faded: they all count from the moment they were written.
	if got := get(t, s, lived).Tier(now); got != TierActive {
		t.Errorf("the lived memory is %s after the import, want active", got)
	}
	if c, _ := s.TierCounts(ctx, now); c.Active != 405 || c.Faded != 0 || c.Archived != 0 {
		t.Errorf("counts after the import: %+v, want all 405 active", c)
	}
	m := get(t, s, first)
	if m.Ord != 5 || m.TouchedOrd != 5 || m.Source != SourceReconstructed || !m.Pending ||
		!m.CreatedAt.Equal(t0.AddDate(0, 0, -400)) || !m.WrittenAt.Equal(t0) || !near(m.Strength, 10, 1e-9) {
		t.Errorf("a reconstructed memory: %+v", m)
	}
	// Listed by when things happened, not by when they were written down.
	all, err := s.Recent(ctx, now, 1000)
	if err != nil || len(all) != 405 {
		t.Fatalf("recent: %d memories (err %v), want 405", len(all), err)
	}
	if all[5].ID != last || all[404].ID != first || !has([]string{all[0].ID, all[1].ID, all[2].ID, all[3].ID, all[4].ID}, lived) {
		t.Errorf("recent: the five lived today should come first, then the accounts from the newest to the oldest")
	}

	// A retried write of the same account is not stored twice.
	again, dup, err := s.Remember(ctx, t0.Add(time.Minute), RememberInput{SessionID: sess.ID, Moment: "other", Source: SourceReconstructed,
		Importance: 0.5, Gist: "旧会话 " + t0.AddDate(0, 0, -1).Format(time.DateOnly), Body: "从记录里整理出来的。", Happened: t0.AddDate(0, 0, -1)})
	if err != nil || !dup || again != last {
		t.Errorf("retried reconstructed write: id=%s dup=%v err=%v, want %s as a duplicate", again, dup, err, last)
	}

	// From here on they fade with what is lived, like anything else.
	fill(t, s, sess.ID, 13)
	if c, _ := s.TierCounts(ctx, clock(t, s)); c.Faded != 405 || c.Active != 13 {
		t.Errorf("13 lived memories later: %+v, want the 405 faded and 13 active", c)
	}
	replays(t, s)
}
