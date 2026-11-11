package store

import (
	"context"
	"math"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

const day = 24 * time.Hour

func near(got, want, tolerance float64) bool { return math.Abs(got-want) <= tolerance }

func get(t *testing.T, s *Store, id string) Memory {
	t.Helper()
	ms, err := s.Get(context.Background(), []string{id})
	if err != nil || len(ms) != 1 {
		t.Fatalf("get %s: %v, %d memories", id, err, len(ms))
	}
	return ms[0]
}

func recallAt(t *testing.T, s *Store, at time.Time, ids ...string) {
	t.Helper()
	if err := s.LogRecalls(context.Background(), []RecallNote{{At: at, Query: "q", IDs: ids}}); err != nil {
		t.Fatalf("log recall: %v", err)
	}
}

func rememberWith(t *testing.T, s *Store, at time.Time, in RememberInput) string {
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
	id, dup, err := s.Remember(context.Background(), at, in)
	if err != nil || dup {
		t.Fatalf("remember %q: err=%v dup=%v", in.Gist, err, dup)
	}
	return id
}

func TestInitialStrength(t *testing.T) {
	p := DefaultParams()
	for _, tc := range []struct {
		importance, intensity float64
		source                string
		want                  float64 // days
	}{
		{0.5, 0, "lived", 30},
		{1.0, 0, "lived", 120},
		{0.0, 0, "lived", 7.5},
		{0.75, 0, "lived", 60},
		{0.5, 1, "lived", 60},
		{0.5, 0.5, "lived", 45},
		{0.5, 0, "told", 21},
		{0.5, 0, "inferred", 12},
	} {
		if got := p.initialStrength(tc.importance, tc.intensity, tc.source); !near(got, tc.want, 1e-9) {
			t.Errorf("initialStrength(%v, %v, %s) = %v days, want %v", tc.importance, tc.intensity, tc.source, got, tc.want)
		}
	}
}

func TestParamsAreValidated(t *testing.T) {
	bad := []func(*Params){
		func(p *Params) { p.BaseStrengthDays = 0 },
		func(p *Params) { p.RecallBoost = -1 },
		func(p *Params) { p.FadeBelow = 1 },
		func(p *Params) { p.ArchiveBelow = 0 },
		func(p *Params) { p.ArchiveBelow = p.FadeBelow },
		func(p *Params) { p.CoreImportance = 0 },
		func(p *Params) { p.BaseStrengthDays = math.NaN() },
	}
	for i, change := range bad {
		p := DefaultParams()
		change(&p)
		if s, err := Open(context.Background(), filepath.Join(t.TempDir(), "ziwo.db"), p); err == nil {
			s.Close()
			t.Errorf("case %d: Open accepted %+v", i, p)
		}
	}
}

func TestMemoryFadesThenIsArchived(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	m := get(t, s, id)
	// Strength 30 days: R falls below 0.3 after 30*ln(1/0.3) = 36.1 days and
	// below 0.05 after 30*ln(20) = 89.9 days.
	if !near(m.Strength, 30, 1e-9) || m.Core {
		t.Fatalf("strength = %v, core = %v; want 30 days, not core", m.Strength, m.Core)
	}
	if got := m.FadeAt.Sub(t0).Hours() / 24; !near(got, 36.12, 0.01) {
		t.Errorf("fades after %.2f days, want 36.12", got)
	}
	if got := m.ArchiveAt.Sub(t0).Hours() / 24; !near(got, 89.87, 0.01) {
		t.Errorf("archived after %.2f days, want 89.87", got)
	}
	if got := m.Retention(t0.Add(30 * day)); !near(got, math.Exp(-1), 1e-9) {
		t.Errorf("retention after one strength = %v, want 1/e", got)
	}

	for _, tc := range []struct {
		after       time.Duration
		tier        Tier
		counts      TierCounts
		gist, body  bool // found by an ordinary search on a gist word, on a body word
		deepBody    bool
		shownRecent bool
	}{
		{36 * day, TierActive, TierCounts{Active: 1}, true, true, true, true},
		{37 * day, TierFaded, TierCounts{Faded: 1}, true, false, true, true},
		{89 * day, TierFaded, TierCounts{Faded: 1}, true, false, true, true},
		{90 * day, TierArchived, TierCounts{Archived: 1}, false, false, true, false},
		{3650 * day, TierArchived, TierCounts{Archived: 1}, false, false, true, false},
	} {
		now := t0.Add(tc.after)
		if got := m.Tier(now); got != tc.tier {
			t.Errorf("day %d: tier %s, want %s", tc.after/day, got, tc.tier)
		}
		if got, err := s.TierCounts(ctx, now); err != nil || got != tc.counts {
			t.Errorf("day %d: counts %+v (err %v), want %+v", tc.after/day, got, err, tc.counts)
		}
		if got := len(searchAt(t, s, "猫", now, false)) == 1; got != tc.gist {
			t.Errorf("day %d: ordinary search on a gist word found it = %v, want %v", tc.after/day, got, tc.gist)
		}
		if got := len(searchAt(t, s, "年糕", now, false)) == 1; got != tc.body {
			t.Errorf("day %d: ordinary search on a body word found it = %v, want %v", tc.after/day, got, tc.body)
		}
		if got := len(searchAt(t, s, "年糕", now, true)) == 1; got != tc.deepBody {
			t.Errorf("day %d: deep search on a body word found it = %v, want %v", tc.after/day, got, tc.deepBody)
		}
		recent, err := s.Recent(ctx, now, 10)
		if err != nil {
			t.Fatal(err)
		}
		if got := len(recent) == 1; got != tc.shownRecent {
			t.Errorf("day %d: listed as recent = %v, want %v", tc.after/day, got, tc.shownRecent)
		}
	}

	// None of this wrote anything: fading is read off the clock.
	if _, events, _ := s.Counts(ctx); events != 2 {
		t.Errorf("events = %d, want only the session and the memory", events)
	}
}

func TestRecallStrengthensAndRestores(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "", "cli")
	early := remember(t, s, t0, sess.ID, "十天后被想起", "正文一")
	late := remember(t, s, t0, sess.ID, "四十天后被想起", "正文二")
	never := remember(t, s, t0, sess.ID, "没有被想起", "正文三")

	recallAt(t, s, t0.Add(10*day), early)
	recallAt(t, s, t0.Add(40*day), late)

	// S' = S * (1 + 2*(1 - R)), with R = exp(-t/30).
	wantEarly := 30 * (1 + 2*(1-math.Exp(-10.0/30)))
	wantLate := 30 * (1 + 2*(1-math.Exp(-40.0/30)))
	e, l, n := get(t, s, early), get(t, s, late), get(t, s, never)
	if !near(e.Strength, wantEarly, 1e-6) || !near(l.Strength, wantLate, 1e-6) || !near(n.Strength, 30, 1e-9) {
		t.Errorf("strengths = %.3f, %.3f, %.3f; want %.3f, %.3f, 30", e.Strength, l.Strength, n.Strength, wantEarly, wantLate)
	}
	if !(l.Strength > e.Strength) {
		t.Errorf("a recall after a longer gap must strengthen more: %.1f vs %.1f", l.Strength, e.Strength)
	}

	// On day 41 the one recalled on day 40 is active again; the one never
	// recalled has faded.
	now := t0.Add(41 * day)
	if l.Tier(now) != TierActive || n.Tier(now) != TierFaded {
		t.Errorf("day 41: recalled is %s, never recalled is %s; want active, faded", l.Tier(now), n.Tier(now))
	}
	if !l.LastRecalledAt.Equal(t0.Add(40*day)) || l.RecallCount != 1 {
		t.Errorf("last recalled %v, count %d", l.LastRecalledAt, l.RecallCount)
	}
	if got := l.FadeAt.Sub(l.LastRecalledAt).Hours() / 24; !near(got, wantLate*math.Log(1/0.3), 0.01) {
		t.Errorf("fades %.2f days after the recall, want %.2f", got, wantLate*math.Log(1/0.3))
	}

	// A second recall at the same moment finds nothing to restore.
	recallAt(t, s, t0.Add(40*day), late)
	if again := get(t, s, late); !near(again.Strength, wantLate, 1e-6) || again.RecallCount != 2 {
		t.Errorf("immediate second recall: strength %.3f, count %d; want %.3f, 2", again.Strength, again.RecallCount, wantLate)
	}
	// A recall dated before the last one does not move the memory back.
	recallAt(t, s, t0.Add(20*day), late)
	if back := get(t, s, late); !back.LastRecalledAt.Equal(t0.Add(40*day)) || !near(back.Strength, wantLate, 1e-6) {
		t.Errorf("out-of-order recall changed the memory: last %v, strength %.3f", back.LastRecalledAt, back.Strength)
	}

	// An archived memory comes back too.
	recallAt(t, s, t0.Add(400*day), never)
	if back := get(t, s, never); back.Tier(t0.Add(401*day)) != TierActive || !near(back.Strength, 30*(1+2*(1-math.Exp(-400.0/30))), 1e-6) {
		t.Errorf("recalled from the archive: tier %s, strength %.3f", back.Tier(t0.Add(401*day)), back.Strength)
	}
}

func TestCoreMemoriesNeverFade(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	important := rememberWith(t, s, t0, RememberInput{SessionID: sess.ID, Importance: 0.9, Gist: "第一次被信任", Body: "用户把整个项目交给了我。"})
	felt := rememberWith(t, s, t0, RememberInput{SessionID: sess.ID, Importance: 0.3, Intensity: 0.95, Feeling: "很难忘", Gist: "用户向我道别", Body: "他说以后可能不再用了。"})
	ordinary := rememberWith(t, s, t0, RememberInput{SessionID: sess.ID, Importance: 0.89, Intensity: 0.89, Feeling: "还好", Gist: "差一点的事", Body: "两项都没到门槛。"})

	farFuture := t0.Add(36500 * day)
	for _, id := range []string{important, felt} {
		m := get(t, s, id)
		if !m.Core || m.Tier(farFuture) != TierCore || m.Retention(farFuture) != 1 || !m.FadeAt.IsZero() || !m.ArchiveAt.IsZero() {
			t.Errorf("%s: core=%v tier=%s retention=%v fadeAt=%v", m.Gist, m.Core, m.Tier(farFuture), m.Retention(farFuture), m.FadeAt)
		}
	}
	if m := get(t, s, ordinary); m.Core || m.Tier(farFuture) != TierArchived {
		t.Errorf("just under both thresholds: core=%v tier=%s", m.Core, m.Tier(farFuture))
	}

	if got := searchAt(t, s, "整个项目", farFuture, false); !reflect.DeepEqual(got, []string{important}) {
		t.Errorf("a core memory must stay searchable by its details forever, got %v", got)
	}
	if counts, _ := s.TierCounts(ctx, farFuture); counts != (TierCounts{Core: 2, Archived: 1}) {
		t.Errorf("counts = %+v", counts)
	}
	core, err := s.Core(ctx, 10)
	if err != nil || len(core) != 2 || core[0].ID != important {
		t.Errorf("Core() = %d memories (err %v), want 2 with the most important first", len(core), err)
	}
	recent, _ := s.Recent(ctx, farFuture, 10)
	if len(recent) != 2 {
		t.Errorf("recent in the far future = %d memories, want the 2 core ones", len(recent))
	}

	// Recalling a core memory counts, and leaves it core.
	recallAt(t, s, t0.Add(50*day), important)
	if m := get(t, s, important); !m.Core || m.RecallCount != 1 || !m.FadeAt.IsZero() {
		t.Errorf("after a recall: core=%v count=%d fadeAt=%v", m.Core, m.RecallCount, m.FadeAt)
	}
}

func TestChangingParamsReplaysTheLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ziwo.db")
	ctx := context.Background()
	s := open(t, path)
	sess := session(t, s, t0, "", "cli")
	id := remember(t, s, t0, sess.ID, "同一段记忆", "参数变了，它跟着变。")
	big := rememberWith(t, s, t0, RememberInput{SessionID: sess.ID, Importance: 0.8, Gist: "比较重要的事", Body: "正文"})
	recallAt(t, s, t0.Add(10*day), id)
	before := get(t, s, id)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	p := DefaultParams()
	p.BaseStrengthDays = 60
	p.RecallBoost = 0
	p.CoreImportance = 0.8
	s2, err := Open(ctx, path, p)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	after := get(t, s2, id)
	if !near(after.Strength, 60, 1e-9) || after.RecallCount != 1 || !after.LastRecalledAt.Equal(before.LastRecalledAt) {
		t.Errorf("after reopening with new params: strength %v, count %d; want 60 (no boost), 1", after.Strength, after.RecallCount)
	}
	if !get(t, s2, big).Core {
		t.Error("lowering the core threshold did not make the important memory core")
	}
	if _, events, _ := s2.Counts(ctx); events != 4 {
		t.Errorf("events = %d, want 4: the log itself must not change", events)
	}
}

func TestArchivedMemoriesLoseTheirVectors(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	a := get(t, s, remember(t, s, t0, sess.ID, "甲", "会被归档"))
	b := get(t, s, remember(t, s, t0, sess.ID, "乙", "会被归档后又被想起"))
	c := get(t, s, rememberWith(t, s, t0, RememberInput{SessionID: sess.ID, Importance: 0.95, Gist: "丙", Body: "核心记忆"}))
	for _, m := range []Memory{a, b, c} {
		for _, model := range []string{"model-x", "model-y"} {
			if err := s.SaveVector(ctx, m.N, model, []float32{1, 2}); err != nil {
				t.Fatal(err)
			}
		}
	}

	if dropped, err := s.DropArchivedVectors(ctx, t0.Add(60*day)); err != nil || len(dropped) != 0 {
		t.Errorf("day 60, nothing archived yet: dropped %v (err %v)", dropped, err)
	}
	later := t0.Add(100 * day)
	dropped, err := s.DropArchivedVectors(ctx, later)
	if err != nil || len(dropped) != 2 || !((dropped[0] == a.N && dropped[1] == b.N) || (dropped[0] == b.N && dropped[1] == a.N)) {
		t.Fatalf("day 100: dropped %v (err %v), want the two archived memories once each", dropped, err)
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

	// Archived memories are not queued for embedding. One that is recalled is.
	if pending, _ := s.Unembedded(ctx, "model-x", later, 10); len(pending) != 0 {
		t.Errorf("archived memories queued for embedding: %d", len(pending))
	}
	recallAt(t, s, later, b.ID)
	pending, _ := s.Unembedded(ctx, "model-x", later.Add(time.Hour), 10)
	if len(pending) != 1 || pending[0].ID != b.ID {
		t.Errorf("after a recall, queued for embedding: %d memories, want just the recalled one", len(pending))
	}
}
