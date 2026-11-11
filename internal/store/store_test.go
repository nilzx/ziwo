package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)

// testParams make forgetting quick to reach: with a strength of 10, an
// ordinary memory fades once 13 newer memories have been written without it
// coming to mind, and is archived after 30.
func testParams() Params {
	p := DefaultParams()
	p.BaseStrength = 10
	return p
}

func open(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(context.Background(), path, Options{Params: testParams(), Create: true})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func newStore(t *testing.T) *Store {
	return open(t, filepath.Join(t.TempDir(), "test.ziwo"))
}

func session(t *testing.T, s *Store, at time.Time, model, client string) Session {
	t.Helper()
	sess, _, err := s.StartSession(context.Background(), at, model, client)
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	return sess
}

func remember(t *testing.T, s *Store, at time.Time, sess, gist, body string) string {
	t.Helper()
	id, dup, err := s.Remember(context.Background(), at, RememberInput{
		SessionID: sess, Moment: "other", Source: "lived", Importance: 0.5, Gist: gist, Body: body,
	})
	if err != nil {
		t.Fatalf("remember: %v", err)
	}
	if dup {
		t.Fatalf("remember %q: unexpectedly a duplicate", gist)
	}
	return id
}

var fillers int

// fill writes n memories that match none of the tests' searches. Each one
// advances the experience clock by one.
func fill(t *testing.T, s *Store, sess string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		fillers++
		remember(t, s, t0, sess, fmt.Sprintf("filler %d", fillers), "padding")
	}
}

func clock(t *testing.T, s *Store) int64 {
	t.Helper()
	c, err := s.Clock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func get(t *testing.T, s *Store, id string) Memory {
	t.Helper()
	ms, err := s.Get(context.Background(), []string{id})
	if err != nil || len(ms) != 1 {
		t.Fatalf("get %s: %v, %d memories", id, err, len(ms))
	}
	return ms[0]
}

// searchIDs runs an ordinary search at the current clock.
func searchIDs(t *testing.T, s *Store, query string) []string {
	t.Helper()
	return search(t, s, query, false)
}

func search(t *testing.T, s *Store, query string, deep bool) []string {
	t.Helper()
	ctx := context.Background()
	hits, err := s.SearchText(ctx, query, clock(t, s), deep, 10)
	if err != nil {
		t.Fatalf("search %q: %v", query, err)
	}
	if len(hits) == 0 {
		return nil
	}
	ns := make([]int64, len(hits))
	for i, h := range hits {
		ns[i] = h.N
		if h.Score <= 0 || (i > 0 && h.Score > hits[i-1].Score) {
			t.Errorf("search %q: hit %d has score %v after %v; want positive and descending", query, i, h.Score, hits[max(i-1, 0)].Score)
		}
	}
	byN, err := s.ByN(ctx, ns)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(ns))
	for i, n := range ns {
		ids[i] = byN[n].ID
	}
	return ids
}

func TestMatchQuery(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{"?!，。", ""},
		{"猫", `"猫"`},
		{"记忆系统", `"记 忆" OR "忆 系" OR "系 统"`},
		{"Go SDK", `"go" OR "sdk"`},
		{"用Go写的", `"用" OR "go" OR "写 的"`},
		{`"quoted" OR NOT`, `"quoted" OR "or" OR "not"`},
		{"记忆 记忆", `"记 忆"`},
	} {
		if got := matchQuery(tc.in); got != tc.want {
			t.Errorf("matchQuery(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}

func TestKeywordSearch(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "model-a", "desktop")
	corrected := remember(t, s, t0, sess.ID,
		"用户纠正了我对记忆系统的理解", "我把它当成了项目笔记本，用户说它应该记的是经历和感受。")
	deploy := remember(t, s, t0.Add(time.Minute), sess.ID,
		"First deployment went wrong", "The reverse proxy rejected every request until the Host header was fixed.")
	cat := remember(t, s, t0.Add(2*time.Minute), sess.ID,
		"用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	for _, tc := range []struct {
		query string
		want  []string
	}{
		{"纠正", []string{corrected}},
		{"项目笔记本", []string{corrected}},
		{"猫", []string{cat}},
		{"年糕", []string{cat}},
		{"PROXY", []string{deploy}},
		{"host header", []string{deploy}},
		{"完全无关的词", nil},
		{"...", nil},
	} {
		if got := searchIDs(t, s, tc.query); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("search %q = %v, want %v", tc.query, got, tc.want)
		}
	}

	// A natural-language question shares only some two-character pieces with
	// the memory, and still has to find it first.
	if got := searchIDs(t, s, "上次用户是怎么纠正我的理解的"); len(got) == 0 || got[0] != corrected {
		t.Errorf("question search = %v, want %s first", got, corrected)
	}
}

func TestOpenNeedsCreateForAMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.ziwo")
	if _, err := Open(context.Background(), path, Options{Params: testParams()}); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("err = %v, want a not-exist error", err)
	}
	if _, err := filepath.Glob(path + "*"); err != nil {
		t.Fatal(err)
	} else if left, _ := filepath.Glob(path + "*"); len(left) != 0 {
		t.Errorf("a refused open left files behind: %v", left)
	}
}

// A memory file holds a private life. It and the files SQLite keeps next to
// it are readable by their owner only.
func TestNewFileIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	s := open(t, path)
	sess := session(t, s, t0, "", "cli")
	remember(t, s, t0, sess.ID, "一件事", "正文")
	files, err := filepath.Glob(path + "*")
	if err != nil || len(files) < 2 {
		t.Fatalf("files while open: %v (err %v), want the memory and its write-ahead log", files, err)
	}
	for _, f := range files {
		if info, err := os.Stat(f); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %v (err %v), want 0600", filepath.Base(f), info.Mode().Perm(), err)
		}
	}
	s.Close()

	// Opening it again leaves the permissions its owner has since chosen.
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	open(t, path).Close()
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o640 {
		t.Errorf("after reopening: mode %v (err %v), want 0640 left alone", info.Mode().Perm(), err)
	}
}

func TestEventsAreAppendOnly(t *testing.T) {
	s := newStore(t)
	session(t, s, t0, "model-a", "desktop")
	for _, stmt := range []string{
		`UPDATE events SET payload = '{}'`,
		`DELETE FROM events`,
	} {
		if _, err := s.w.Exec(stmt); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Errorf("%s: err = %v, want an append-only refusal", stmt, err)
		}
	}
	if _, events, _ := s.Counts(context.Background()); events != 1 {
		t.Errorf("events = %d, want 1", events)
	}
}

func TestReadPoolCannotWrite(t *testing.T) {
	s := newStore(t)
	if _, err := s.r.Exec(`INSERT INTO meta(key, value) VALUES('x', 'y')`); err == nil {
		t.Error("write through the read pool succeeded")
	}
}

func TestRememberDeduplicatesRetries(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	in := RememberInput{SessionID: sess.ID, Moment: "other", Source: "lived", Importance: 0.5, Gist: "同一件事", Body: "写了两次"}

	first, dup, err := s.Remember(ctx, t0, in)
	if err != nil || dup {
		t.Fatalf("first: id=%s dup=%v err=%v", first, dup, err)
	}
	again, dup, err := s.Remember(ctx, t0.Add(time.Minute), in)
	if err != nil || !dup || again != first {
		t.Errorf("retry: id=%s dup=%v err=%v, want %s as a duplicate", again, dup, err, first)
	}
	if got := clock(t, s); got != 1 {
		t.Errorf("clock after a retried write = %d, want 1: a retry is not a new experience", got)
	}
	later, dup, err := s.Remember(ctx, t0.Add(DedupWindow+time.Minute), in)
	if err != nil || dup || later == first {
		t.Errorf("after the window: id=%s dup=%v err=%v, want a new memory", later, dup, err)
	}
	if memories, _, _ := s.Counts(ctx); memories != 2 {
		t.Errorf("memories = %d, want 2", memories)
	}
}

func TestRememberNeedsASession(t *testing.T) {
	s := newStore(t)
	_, _, err := s.Remember(context.Background(), t0, RememberInput{
		SessionID: "s_missing", Moment: "other", Source: "lived", Importance: 0.5, Gist: "g", Body: "b",
	})
	if !errors.Is(err, ErrNoSession) {
		t.Errorf("err = %v, want %v", err, ErrNoSession)
	}
	if _, events, _ := s.Counts(context.Background()); events != 0 {
		t.Errorf("events = %d, want none written", events)
	}

	// Repeating what a real session just wrote does not get it past the check.
	sess := session(t, s, t0, "", "cli")
	remember(t, s, t0, sess.ID, "g", "b")
	for _, id := range []string{"s_missing", ""} {
		got, dup, err := s.Remember(context.Background(), t0.Add(time.Second), RememberInput{
			SessionID: id, Moment: "other", Source: "lived", Importance: 0.5, Gist: "g", Body: "b",
		})
		if !errors.Is(err, ErrNoSession) || dup || got != "" {
			t.Errorf("session %q repeating a recent memory: id=%q dup=%v err=%v, want %v", id, got, dup, err, ErrNoSession)
		}
	}
}

func TestCarrierNote(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	start := func(at time.Time, model string) CarrierNote {
		t.Helper()
		_, note, err := s.StartSession(ctx, at, model, "desktop")
		if err != nil {
			t.Fatal(err)
		}
		return note
	}

	if note := start(t0, "model-a"); note.First || len(note.Earlier) != 0 {
		t.Errorf("very first model: %+v, want nothing to report", note)
	}
	if note := start(t0.Add(time.Hour), "model-a"); note.First {
		t.Errorf("same model again: %+v, want First = false", note)
	}
	if note := start(t0.Add(2*time.Hour), ""); note.First || len(note.Earlier) != 0 {
		t.Errorf("unknown model: %+v, want nothing to report", note)
	}
	note := start(t0.Add(3*time.Hour), "model-b")
	if !note.First || !reflect.DeepEqual(note.Earlier, []string{"model-a"}) {
		t.Errorf("new model: %+v, want First with model-a earlier", note)
	}
	if note := start(t0.Add(4*time.Hour), "model-a"); note.First || !reflect.DeepEqual(note.Earlier, []string{"model-b"}) {
		t.Errorf("back to the old model: %+v, want First = false, model-b earlier", note)
	}
}

func TestMemoryCarriesItsCarrier(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	a := session(t, s, t0, "model-a", "desktop")
	b := session(t, s, t0.Add(time.Hour), "model-b", "cli")
	first := remember(t, s, t0, a.ID, "第一段", "由 model-a 写下")
	second := remember(t, s, t0.Add(time.Hour), b.ID, "第二段", "由 model-b 写下")

	ms, err := s.Get(ctx, []string{second, "m_unknown", first})
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != second || ms[1].ID != first {
		t.Fatalf("Get returned %d memories in the wrong order", len(ms))
	}
	if ms[0].Model != "model-b" || ms[0].Client != "cli" || ms[1].Model != "model-a" || ms[1].Client != "desktop" {
		t.Errorf("carriers = %s/%s and %s/%s", ms[0].Model, ms[0].Client, ms[1].Model, ms[1].Client)
	}
}

func TestActiveSessions(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	a := session(t, s, t0, "model-a", "desktop")
	b := session(t, s, t0.Add(10*time.Minute), "model-b", "cli")
	c := session(t, s, t0.Add(20*time.Minute), "", "web")

	ids := func(since time.Time, except string) []string {
		t.Helper()
		found, err := s.ActiveSessions(ctx, since, except, 10)
		if err != nil {
			t.Fatal(err)
		}
		out := make([]string, len(found))
		for i, f := range found {
			out[i] = f.ID
		}
		return out
	}
	if got := ids(t0.Add(5*time.Minute), c.ID); !reflect.DeepEqual(got, []string{b.ID}) {
		t.Errorf("active since minute 5, other than c: %v, want only b", got)
	}

	// Writing and recalling count as activity; the newest activity comes first.
	m := remember(t, s, t0.Add(30*time.Minute), a.ID, "一件事", "正文")
	if err := s.LogRecalls(ctx, []RecallNote{{At: t0.Add(40 * time.Minute), Session: b.ID, Query: "q", IDs: []string{m}}}); err != nil {
		t.Fatal(err)
	}
	if got := ids(t0.Add(25*time.Minute), c.ID); !reflect.DeepEqual(got, []string{b.ID, a.ID}) {
		t.Errorf("after a wrote and b recalled: %v, want b then a", got)
	}
	if sess, ok, _ := s.Session(ctx, a.ID); !ok || !sess.LastActiveAt.Equal(t0.Add(30*time.Minute)) || !sess.StartedAt.Equal(t0) {
		t.Errorf("session a: started %v, last active %v", sess.StartedAt, sess.LastActiveAt)
	}
}

func TestLogOnlyLeavesDerivedTablesAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	ctx := context.Background()

	// A file can be created, and given a token, without a single derived table.
	lo, err := Open(ctx, path, Options{Create: true, LogOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := lo.TokenHash(ctx); ok {
		t.Error("a new file already has a token")
	}
	if err := lo.SetTokenHash(ctx, "abc123"); err != nil {
		t.Fatal(err)
	}
	var tables int
	if err := lo.r.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name IN ('memories', 'sessions')`).Scan(&tables); err != nil || tables != 0 {
		t.Errorf("derived tables after a log-only open: %d (err %v), want none", tables, err)
	}
	lo.Close()

	s := open(t, path)
	sess := session(t, s, t0, "", "cli")
	remember(t, s, t0.Add(time.Minute), sess.ID, "一件事", "正文")
	if hash, ok, _ := s.TokenHash(ctx); !ok || hash != "abc123" {
		t.Errorf("token hash = %q, %v", hash, ok)
	}
	before := dump(t, s)
	s.Close()

	// Opening it log-only again, with no parameters at all, must not rebuild
	// what the server derived with its own parameters.
	lo, err = Open(ctx, path, Options{LogOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	stats, err := lo.LogStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Memories != 1 || stats.Events != 2 || !stats.HasToken || !stats.LastEventAt.Equal(t0.Add(time.Minute)) {
		t.Errorf("log stats = %+v", stats)
	}
	lo.Close()
	if after := dump(t, open(t, path)); after != before {
		t.Errorf("a log-only open changed the derived tables\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// dump returns every row of the derived tables as text.
func dump(t *testing.T, s *Store) string {
	t.Helper()
	var b strings.Builder
	for _, q := range []string{
		`SELECT * FROM sessions ORDER BY id`,
		`SELECT * FROM carriers ORDER BY model`,
		`SELECT * FROM memories ORDER BY n`,
		`SELECT n, model, hex(vec) FROM vectors ORDER BY n, model`,
		`SELECT value FROM meta WHERE key = 'derived'`,
	} {
		rows, err := s.r.Query(q)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintf(&b, "%v\n", vals)
		}
		rows.Close()
		b.WriteString("--\n")
	}
	for _, q := range []string{"纠正", "proxy", "猫"} {
		fmt.Fprintf(&b, "%s: %v\n", q, searchIDs(t, s, q))
	}
	return b.String()
}

// populate writes a little of everything: two carriers, plain and rich
// memories, a listing, a reading and a vector.
func populate(t *testing.T, s *Store) {
	t.Helper()
	ctx := context.Background()
	a := session(t, s, t0, "model-a", "desktop")
	b := session(t, s, t0.Add(time.Hour), "model-b", "cli")
	m1 := remember(t, s, t0, a.ID, "用户纠正了我", "我理解偏了，用户直接指出来并解释了原因。")
	m2 := remember(t, s, t0.Add(time.Hour), b.ID, "Proxy trouble", "The proxy dropped the connection twice.")
	if _, _, err := s.Remember(ctx, t0.Add(2*time.Hour), RememberInput{
		SessionID: b.ID, Moment: "emotion", Source: "told", Importance: 0.9, Intensity: 0.4,
		Gist: "用户说他养了一只猫", Body: "他说猫叫年糕。", Outcome: "聊得很开心", Feeling: "轻松",
		Lesson: "闲聊也值得认真听", People: []string{"年糕"}, Pointer: "https://example.com/repo",
	}); err != nil {
		t.Fatal(err)
	}
	fill(t, s, b.ID, 4)
	if err := s.LogRecalls(ctx, []RecallNote{
		{At: t0.Add(3 * time.Hour), Session: b.ID, Query: "纠正", IDs: []string{m1, m2}},
		{At: t0.Add(4 * time.Hour), Session: b.ID, Read: true, IDs: []string{m1}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveVector(ctx, get(t, s, m1).N, "embed-x", []float32{0.25, -1.5, 3}); err != nil {
		t.Fatal(err)
	}
}

func TestRebuildReproducesDerivedTables(t *testing.T) {
	s := newStore(t)
	populate(t, s)
	before := dump(t, s)

	if err := s.Rebuild(context.Background()); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if after := dump(t, s); after != before {
		t.Errorf("derived tables changed across a rebuild\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

func TestReopenKeepsEverythingAndUpgradesDerivedTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	s := open(t, path)
	populate(t, s)
	before := dump(t, s)
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// Stand in for an older release: stale version marker, derived tables in
	// a layout this code does not know.
	raw, err := sql.Open("sqlite3", fileURI(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`UPDATE meta SET value = '0' WHERE key = 'derived';
		DROP TABLE memories; CREATE TABLE memories(old_layout TEXT);`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	s2 := open(t, path)
	if after := dump(t, s2); after != before {
		t.Errorf("reopened store differs\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

func TestVectorsRoundTripPerModel(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	m1 := get(t, s, remember(t, s, t0, sess.ID, "一", "一"))
	id2 := remember(t, s, t0, sess.ID, "二", "二")

	want := []float32{0.5, -0.25, 1e-7, 12345.678}
	if err := s.SaveVector(ctx, m1.N, "model-x", []float32{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveVector(ctx, m1.N, "model-x", want); err != nil { // replaces
		t.Fatal(err)
	}
	if err := s.SaveVector(ctx, m1.N, "model-y", []float32{9}); err != nil {
		t.Fatal(err)
	}

	got := map[int64][]float32{}
	if err := s.Vectors(ctx, "model-x", func(n int64, v []float32) error { got[n] = v; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !reflect.DeepEqual(got[m1.N], want) {
		t.Errorf("vectors for model-x = %v, want only %v", got, want)
	}

	pending, err := s.Unembedded(ctx, "model-x", clock(t, s), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].ID != id2 {
		t.Errorf("unembedded for model-x = %d memories, want just %s", len(pending), id2)
	}
	if pending, _ := s.Unembedded(ctx, "model-z", clock(t, s), 10); len(pending) != 2 {
		t.Errorf("unembedded for an unused model = %d, want 2", len(pending))
	}
}
