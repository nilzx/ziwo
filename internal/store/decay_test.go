package store

import (
	"context"
	"math"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// With testParams the strength of an ordinary memory is 10, so it fades
// 10*ln(1/0.3) = 12.04 memories after it last came to mind and is archived
// 10*ln(20) = 29.96 memories after.
const (
	fadeAfter    = 12.039728
	archiveAfter = 29.957323
)

func near(got, want, tolerance float64) bool { return math.Abs(got-want) <= tolerance }

func listed(t *testing.T, s *Store, ids ...string) {
	t.Helper()
	if err := s.LogRecalls(context.Background(), []RecallNote{{At: t0, Query: "q", IDs: ids}}); err != nil {
		t.Fatalf("log listing: %v", err)
	}
}

func read(t *testing.T, s *Store, ids ...string) {
	t.Helper()
	if err := s.LogRecalls(context.Background(), []RecallNote{{At: t0, Read: true, IDs: ids}}); err != nil {
		t.Fatalf("log reading: %v", err)
	}
}

func rememberWith(t *testing.T, s *Store, in RememberInput) string {
	t.Helper()
	if in.Moment == "" {
		in.Moment = "other"
	}
	if in.Source == "" {
		in.Source = "lived"
	}
	if in.Importance == 0 {
		in.Importance = 0.5
	}
	id, dup, err := s.Remember(context.Background(), t0, in)
	if err != nil || dup {
		t.Fatalf("remember %q: err=%v dup=%v", in.Gist, err, dup)
	}
	return id
}

func TestInitialStrength(t *testing.T) {
	p := DefaultParams() // base strength 100
	for _, tc := range []struct {
		importance, intensity float64
		source                string
		want                  float64
	}{
		{0.5, 0, "lived", 100},
		{1.0, 0, "lived", 400},
		{0.0, 0, "lived", 25},
		{0.75, 0, "lived", 200},
		{0.5, 1, "lived", 200},
		{0.5, 0.5, "lived", 150},
		{0.5, 0, "told", 70},
		{0.5, 0, "inferred", 40},
	} {
		if got := p.initialStrength(tc.importance, tc.intensity, tc.source); !near(got, tc.want, 1e-9) {
			t.Errorf("initialStrength(%v, %v, %s) = %v, want %v", tc.importance, tc.intensity, tc.source, got, tc.want)
		}
	}
}

func TestParamsAreValidated(t *testing.T) {
	bad := []func(*Params){
		func(p *Params) { p.BaseStrength = 0 },
		func(p *Params) { p.RecallBoost = -1 },
		func(p *Params) { p.FadeBelow = 1 },
		func(p *Params) { p.ArchiveBelow = 0 },
		func(p *Params) { p.ArchiveBelow = p.FadeBelow },
		func(p *Params) { p.CoreImportance = 0 },
		func(p *Params) { p.BaseStrength = math.NaN() },
	}
	for i, change := range bad {
		p := DefaultParams()
		change(&p)
		if s, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.ziwo"), Options{Params: p, Create: true}); err == nil {
			s.Close()
			t.Errorf("case %d: Open accepted %+v", i, p)
		}
	}
}

func TestMemoryFadesAsNewerOnesAreWritten(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	m := get(t, s, id)
	if !near(m.Strength, 10, 1e-9) || m.Core || m.Ord != 1 || m.TouchedOrd != 1 || m.ReadOrd != 1 {
		t.Fatalf("new memory: strength %v, core %v, ord %d/%d/%d", m.Strength, m.Core, m.Ord, m.TouchedOrd, m.ReadOrd)
	}
	if !near(m.FadeAt, 1+fadeAfter, 1e-5) || !near(m.ArchiveAt, 1+archiveAfter, 1e-5) {
		t.Errorf("crossings at clock %.3f and %.3f, want %.3f and %.3f", m.FadeAt, m.ArchiveAt, 1+fadeAfter, 1+archiveAfter)
	}
	if got := m.Retention(11); !near(got, math.Exp(-1), 1e-9) {
		t.Errorf("retention once 10 memories were written = %v, want 1/e", got)
	}

	// Time alone forgets nothing: ten years on, with nothing lived through,
	// the clock has not moved.
	session(t, s, t0.AddDate(10, 0, 0), "", "cli")
	if c := clock(t, s); c != 1 || m.Tier(c) != TierActive {
		t.Fatalf("ten years later: clock %d, tier %s; want 1, active", c, m.Tier(c))
	}

	written := 0
	for _, tc := range []struct {
		newer            int // memories written after it
		tier             Tier
		counts           TierCounts
		gist, body, deep bool // found by a gist word, by a body word, by a body word in a deep search
		recent           bool
	}{
		{12, TierActive, TierCounts{Active: 13}, true, true, true, true},
		{13, TierFaded, TierCounts{Active: 13, Faded: 1}, true, false, true, true},
		{29, TierFaded, TierCounts{Active: 13, Faded: 17}, true, false, true, true},
		{30, TierArchived, TierCounts{Active: 13, Faded: 17, Archived: 1}, false, false, true, false},
	} {
		fill(t, s, sess.ID, tc.newer-written)
		written = tc.newer
		c := clock(t, s)
		if got := m.Tier(c); got != tc.tier {
			t.Errorf("%d newer: tier %s, want %s", tc.newer, got, tc.tier)
		}
		// The number of active memories settles at 13 however many are written.
		if got, err := s.TierCounts(ctx, c); err != nil || got != tc.counts {
			t.Errorf("%d newer: counts %+v (err %v), want %+v", tc.newer, got, err, tc.counts)
		}
		if got := len(search(t, s, "猫", false)) == 1; got != tc.gist {
			t.Errorf("%d newer: ordinary search on a gist word found it = %v, want %v", tc.newer, got, tc.gist)
		}
		if got := len(search(t, s, "年糕", false)) == 1; got != tc.body {
			t.Errorf("%d newer: ordinary search on a body word found it = %v, want %v", tc.newer, got, tc.body)
		}
		if got := len(search(t, s, "年糕", true)) == 1; got != tc.deep {
			t.Errorf("%d newer: deep search on a body word found it = %v, want %v", tc.newer, got, tc.deep)
		}
		recent, err := s.Recent(ctx, c, 100)
		if err != nil {
			t.Fatal(err)
		}
		shown := false
		for _, r := range recent {
			shown = shown || r.ID == id
		}
		if shown != tc.recent {
			t.Errorf("%d newer: listed as recent = %v, want %v", tc.newer, shown, tc.recent)
		}
	}

	// None of this wrote anything about the memory: its tier is read off the clock.
	if _, events, _ := s.Counts(ctx); events != 2+31 {
		t.Errorf("events = %d, want only the 2 sessions and the 31 memories", events)
	}
}

func TestListingRestartsDecayWithoutStrengthening(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "被搜到的事", "正文")
	fill(t, s, sess.ID, 20)
	if got := get(t, s, id).Tier(clock(t, s)); got != TierFaded {
		t.Fatalf("after 20 newer memories: %s, want faded", got)
	}

	listed(t, s, id)
	m := get(t, s, id)
	if m.Tier(21) != TierActive || m.TouchedOrd != 21 || !near(m.FadeAt, 21+fadeAfter, 1e-5) {
		t.Errorf("after being listed: tier %s, touched at %d, fades at %.3f; want active, 21, %.3f", m.Tier(21), m.TouchedOrd, m.FadeAt, 21+fadeAfter)
	}
	if !near(m.Strength, 10, 1e-9) || m.ReadOrd != 1 || m.RecallCount != 1 {
		t.Errorf("after being listed: strength %v, last read at %d, count %d; want 10, 1, 1", m.Strength, m.ReadOrd, m.RecallCount)
	}

	// However often a search turns it up, it grows no stronger.
	for i := 0; i < 5; i++ {
		fill(t, s, sess.ID, 3)
		listed(t, s, id)
	}
	if m := get(t, s, id); !near(m.Strength, 10, 1e-9) || m.RecallCount != 6 || m.Tier(clock(t, s)) != TierActive {
		t.Errorf("after six listings: strength %v, count %d, tier %s; want 10, 6, active", m.Strength, m.RecallCount, m.Tier(clock(t, s)))
	}
}

func TestReadingStrengthensByTheGapSinceTheLastReading(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "", "cli")
	soon := remember(t, s, t0, sess.ID, "很快被读到的事", "正文一")  // ord 1
	late := remember(t, s, t0, sess.ID, "很久才被读到的事", "正文二") // ord 2
	idle := remember(t, s, t0, sess.ID, "没人读的事", "正文三")    // ord 3

	fill(t, s, sess.ID, 4) // clock 7
	read(t, s, soon)       // 6 memories since it was written

	fill(t, s, sess.ID, 15) // clock 22
	// The usual order: a search lists the memory, then it is read. The
	// listing in between must not eat the strengthening.
	listed(t, s, late)
	read(t, s, late) // 20 memories since it was written

	// S' = S * (1 + 2*(1 - R)), with R = exp(-n/10).
	wantSoon := 10 * (1 + 2*(1-math.Exp(-0.6)))
	wantLate := 10 * (1 + 2*(1-math.Exp(-2.0)))
	a, b, c := get(t, s, soon), get(t, s, late), get(t, s, idle)
	if !near(a.Strength, wantSoon, 1e-6) || !near(b.Strength, wantLate, 1e-6) || !near(c.Strength, 10, 1e-9) {
		t.Errorf("strengths = %.4f, %.4f, %.4f; want %.4f, %.4f, 10", a.Strength, b.Strength, c.Strength, wantSoon, wantLate)
	}
	if b.ReadOrd != 22 || b.TouchedOrd != 22 || b.RecallCount != 2 || !near(b.FadeAt, 22+wantLate*math.Log(1/0.3), 1e-5) {
		t.Errorf("after the reading: read at %d, touched at %d, count %d, fades at %.3f", b.ReadOrd, b.TouchedOrd, b.RecallCount, b.FadeAt)
	}

	// Reading it again straight away finds nothing to restore.
	read(t, s, late)
	if again := get(t, s, late); !near(again.Strength, wantLate, 1e-6) || again.RecallCount != 3 {
		t.Errorf("immediate second reading: strength %.4f, count %d; want %.4f, 3", again.Strength, again.RecallCount, wantLate)
	}

	// A reading far in the future uses the strength the memory has by then.
	fill(t, s, sess.ID, 40) // clock 62
	read(t, s, late)
	if far := get(t, s, late); !near(far.Strength, wantLate*(1+2*(1-math.Exp(-40/wantLate))), 1e-6) {
		t.Errorf("third reading: strength %.4f", far.Strength)
	}
}

func TestArchivedMemoryComesBackWhenListed(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "很久以前的事", "正文")
	fill(t, s, sess.ID, 60)
	if got := get(t, s, id).Tier(clock(t, s)); got != TierArchived {
		t.Fatalf("after 60 newer memories: %s, want archived", got)
	}
	listed(t, s, id, "m_gone") // an id that names nothing is ignored
	if m := get(t, s, id); m.Tier(clock(t, s)) != TierActive || !near(m.Strength, 10, 1e-9) {
		t.Errorf("after being listed: tier %s, strength %v; want active, 10", m.Tier(clock(t, s)), m.Strength)
	}
}

func TestCoreMemoriesNeverFade(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	important := rememberWith(t, s, RememberInput{SessionID: sess.ID, Importance: 0.9, Gist: "第一次被信任", Body: "用户把整个项目交给了我。"})
	felt := rememberWith(t, s, RememberInput{SessionID: sess.ID, Importance: 0.3, Intensity: 0.95, Feeling: "很难忘", Gist: "用户向我道别", Body: "他说以后可能不再用了。"})
	ordinary := rememberWith(t, s, RememberInput{SessionID: sess.ID, Importance: 0.89, Intensity: 0.89, Feeling: "还好", Gist: "差一点的事", Body: "两项都没到门槛。"})

	fill(t, s, sess.ID, 400)
	far := clock(t, s)
	for _, id := range []string{important, felt} {
		m := get(t, s, id)
		if !m.Core || m.Tier(far) != TierCore || m.Retention(far) != 1 || m.FadeAt != 0 || m.ArchiveAt != 0 {
			t.Errorf("%s: core=%v tier=%s retention=%v fadeAt=%v", m.Gist, m.Core, m.Tier(far), m.Retention(far), m.FadeAt)
		}
	}
	if m := get(t, s, ordinary); m.Core || m.Tier(far) != TierArchived {
		t.Errorf("just under both thresholds: core=%v tier=%s", m.Core, m.Tier(far))
	}
	if got := search(t, s, "整个项目", false); !reflect.DeepEqual(got, []string{important}) {
		t.Errorf("a core memory must stay searchable by its details for good, got %v", got)
	}
	if counts, _ := s.TierCounts(ctx, far); counts.Core != 2 || counts.Archived == 0 || counts.Total() != 403 {
		t.Errorf("counts = %+v", counts)
	}
	core, err := s.Core(ctx, 10)
	if err != nil || len(core) != 2 || core[0].ID != important {
		t.Errorf("Core() = %d memories (err %v), want 2 with the most important first", len(core), err)
	}

	// Reading a core memory counts, and leaves it core.
	read(t, s, important)
	if m := get(t, s, important); !m.Core || m.RecallCount != 1 || m.FadeAt != 0 {
		t.Errorf("after a reading: core=%v count=%d fadeAt=%v", m.Core, m.RecallCount, m.FadeAt)
	}
}

func TestChangingParamsReplaysTheLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	ctx := context.Background()
	s := open(t, path)
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "同一段记忆", "参数变了，它跟着变。")
	big := rememberWith(t, s, RememberInput{SessionID: sess.ID, Importance: 0.8, Gist: "比较重要的事", Body: "正文"})
	fill(t, s, sess.ID, 5)
	read(t, s, id)
	if before := get(t, s, id); !(before.Strength > 10) {
		t.Fatalf("strength before = %v, want it raised by the reading", before.Strength)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	p := testParams()
	p.BaseStrength = 20
	p.RecallBoost = 0
	p.CoreImportance = 0.8
	s2, err := Open(ctx, path, Options{Params: p})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	after := get(t, s2, id)
	if !near(after.Strength, 20, 1e-9) || after.RecallCount != 1 || after.ReadOrd != 7 {
		t.Errorf("after reopening with new params: strength %v, count %d, read at %d; want 20 (no boost), 1, 7", after.Strength, after.RecallCount, after.ReadOrd)
	}
	if !get(t, s2, big).Core {
		t.Error("lowering the core threshold did not make the important memory core")
	}
	if _, events, _ := s2.Counts(ctx); events != 9 {
		t.Errorf("events = %d, want 9: the log itself must not change", events)
	}
}

func TestArchivedMemoriesLoseTheirVectors(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	a := get(t, s, remember(t, s, t0, sess.ID, "甲", "会被归档"))
	b := get(t, s, remember(t, s, t0, sess.ID, "乙", "会被归档后又被想起"))
	c := get(t, s, rememberWith(t, s, RememberInput{SessionID: sess.ID, Importance: 0.95, Gist: "丙", Body: "核心记忆"}))
	for _, m := range []Memory{a, b, c} {
		for _, model := range []string{"model-x", "model-y"} {
			if err := s.SaveVector(ctx, m.N, model, []float32{1, 2}); err != nil {
				t.Fatal(err)
			}
		}
	}

	fill(t, s, sess.ID, 20)
	if dropped, err := s.DropArchivedVectors(ctx, clock(t, s)); err != nil || len(dropped) != 0 {
		t.Errorf("20 newer memories, nothing archived yet: dropped %v (err %v)", dropped, err)
	}
	fill(t, s, sess.ID, 20)
	later := clock(t, s)
	dropped, err := s.DropArchivedVectors(ctx, later)
	if err != nil || len(dropped) != 2 || !((dropped[0] == a.N && dropped[1] == b.N) || (dropped[0] == b.N && dropped[1] == a.N)) {
		t.Fatalf("40 newer memories: dropped %v (err %v), want the two archived memories once each", dropped, err)
	}
	left := 0
	if err := s.Vectors(ctx, "model-x", func(n int64, _ []float32) error {
		left++
		if n != c.N {
			t.Errorf("a vector of memory %d survived", n)
		}
		return nil
	}); err != nil || left != 1 {
		t.Errorf("vectors left for model-x: %d (err %v), want only the core memory's", left, err)
	}

	// Archived memories are not queued for embedding. One that comes back is.
	queued := func() map[string]bool {
		t.Helper()
		pending, err := s.Unembedded(ctx, "model-x", clock(t, s), 1000)
		if err != nil {
			t.Fatal(err)
		}
		out := make(map[string]bool)
		for _, m := range pending {
			out[m.ID] = true
		}
		return out
	}
	if q := queued(); q[a.ID] || q[b.ID] {
		t.Errorf("archived memories are queued for embedding")
	}
	listed(t, s, b.ID)
	if q := queued(); !q[b.ID] || q[a.ID] {
		t.Errorf("after b came back: queued a=%v b=%v, want only b", q[a.ID], q[b.ID])
	}
}

// The wall clock plays no part: the same events at any times give the same
// forgetting state.
func TestForgettingIgnoresTheWallClock(t *testing.T) {
	state := func(step time.Duration) []float64 {
		s := newStore(t)
		ctx := context.Background()
		at := t0
		sess := session(t, s, at, "", "cli")
		var ids []string
		for i := 0; i < 20; i++ {
			at = at.Add(step)
			id, _, err := s.Remember(ctx, at, RememberInput{SessionID: sess.ID, Moment: "other", Source: "lived",
				Importance: 0.5, Gist: "事 " + string(rune('a'+i)), Body: "正文"})
			if err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		at = at.Add(step)
		if err := s.LogRecalls(ctx, []RecallNote{{At: at, Read: true, IDs: ids[:3]}}); err != nil {
			t.Fatal(err)
		}
		var out []float64
		for _, id := range ids {
			m := get(t, s, id)
			out = append(out, m.Strength, m.FadeAt, m.ArchiveAt, float64(m.TouchedOrd))
		}
		return out
	}
	if seconds, years := state(time.Second), state(20*365*24*time.Hour); !reflect.DeepEqual(seconds, years) {
		t.Errorf("forgetting state depends on how far apart the events were")
	}
}

// A note says at which point its memories came to mind. It is logged a little
// later, and what was written in between must not count as having lain
// between.
func TestComingToMindIsDatedByItsOwnClock(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "读到的事", "正文")
	fill(t, s, sess.ID, 5)  // clock 6: here it is read
	fill(t, s, sess.ID, 10) // clock 16: here the note is logged
	note := func(n RecallNote) Memory {
		t.Helper()
		n.At, n.IDs = t0, []string{id}
		if err := s.LogRecalls(ctx, []RecallNote{n}); err != nil {
			t.Fatal(err)
		}
		return get(t, s, id)
	}

	want := 10 * (1 + 2*(1-math.Exp(-0.5))) // five memories lay between, not fifteen
	m := note(RecallNote{Read: true, Clock: 6})
	if !near(m.Strength, want, 1e-6) || m.TouchedOrd != 6 || m.ReadOrd != 6 || !near(m.FadeAt, 6+want*math.Log(1/0.3), 1e-5) {
		t.Errorf("read at clock 6, logged at 16: strength %.4f, touched %d, read %d, fades at %.3f; want %.4f, 6, 6",
			m.Strength, m.TouchedOrd, m.ReadOrd, m.FadeAt, want)
	}

	// Notes from before that, arriving late, move nothing backwards.
	note(RecallNote{Read: true, Clock: 3})
	m = note(RecallNote{Clock: 2})
	if !near(m.Strength, want, 1e-6) || m.TouchedOrd != 6 || m.ReadOrd != 6 || m.RecallCount != 3 {
		t.Errorf("after two older notes: strength %.4f, touched %d, read %d, count %d; want %.4f, 6, 6, 3",
			m.Strength, m.TouchedOrd, m.ReadOrd, m.RecallCount, want)
	}

	// A note cannot be dated in the future, and one without a date means now.
	m = note(RecallNote{Clock: 99})
	if m.TouchedOrd != 16 || !near(m.Strength, want, 1e-6) {
		t.Errorf("a note dated in the future: touched %d, strength %.4f; want 16, %.4f", m.TouchedOrd, m.Strength, want)
	}
	fill(t, s, sess.ID, 2)
	if m = note(RecallNote{}); m.TouchedOrd != 18 {
		t.Errorf("a note without a clock: touched %d, want 18", m.TouchedOrd)
	}

	// The dates are in the log: replaying it gives the same state.
	before := dump(t, s)
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	if after := dump(t, s); after != before {
		t.Errorf("replay differs\nbefore:\n%s\nafter:\n%s", before, after)
	}
}
