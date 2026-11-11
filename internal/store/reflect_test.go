package store

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func begin(t *testing.T, s *Store, sess string) string {
	t.Helper()
	batch, _, err := s.BeginReflect(context.Background(), t0, sess, 15*time.Minute)
	if err != nil {
		t.Fatalf("begin reflect: %v", err)
	}
	return batch
}

func ent(kind, gist string, from ...string) Entry {
	return Entry{Kind: kind, Gist: gist, Body: "正文：" + gist, Importance: 0.5, From: from}
}

// reflectOn runs one whole round and returns the ids it wrote.
func reflectOn(t *testing.T, s *Store, sess string, entries []Entry, passed ...string) []string {
	t.Helper()
	ids, err := s.FinishReflect(context.Background(), t0, sess, begin(t, s, sess), entries, passed)
	if err != nil {
		t.Fatalf("finish reflect: %v", err)
	}
	return ids
}

// refused runs a round that must be turned down, and returns why.
func refused(t *testing.T, s *Store, sess string, entries ...Entry) string {
	t.Helper()
	before, _, _ := s.Counts(context.Background())
	_, err := s.FinishReflect(context.Background(), t0, sess, begin(t, s, sess), entries, nil)
	var ee *EntryError
	if !errors.As(err, &ee) {
		t.Fatalf("round with %q: err = %v, want it refused over an entry", entries[len(entries)-1].Gist, err)
	}
	if after, _, _ := s.Counts(context.Background()); after != before {
		t.Fatalf("a refused round wrote %d memories", after-before)
	}
	return ee.Error()
}

func TestReflectPutsFragmentsTogether(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	f1 := remember(t, s, t0, sess.ID, "用户让我做一个记忆系统", "一开始我理解成了项目笔记本 alphadetail。")
	f2 := remember(t, s, t0, sess.ID, "用户纠正了我的理解", "他说要记的是经历。")
	f3 := remember(t, s, t0, sess.ID, "设计定下来了", "用户说这正是他想要的。")
	alone := remember(t, s, t0, sess.ID, "用户问了天气", "聊了几句。")
	if n, _ := s.PendingCount(ctx); n != 4 {
		t.Fatalf("pending = %d, want 4", n)
	}

	episode := ent(KindEpisode, "我和用户一起把记忆系统的方向定了下来", f1, f2, f3)
	impression := ent(KindImpression, "说话直接，纠正时会讲原因", f2)
	impression.About = "用户"
	ids := reflectOn(t, s, sess.ID, []Entry{episode, ent(KindLesson, "设计类需求先问清它记什么", f1, f2), impression}, alone)
	e, l, i := get(t, s, ids[0]), get(t, s, ids[1]), get(t, s, ids[2])

	// Reflecting adds nothing to what was lived through.
	if clock(t, s) != 4 {
		t.Errorf("clock = %d, want 4: reflecting must not push memories away", clock(t, s))
	}
	// An account outlasts the moments it was made from; a lesson lasts longest.
	if e.Kind != KindEpisode || !near(e.Strength, 20, 1e-9) || e.Ord != 4 || e.Pending || e.Source != "lived" ||
		l.Kind != KindLesson || !near(l.Strength, 40, 1e-9) || i.Kind != KindImpression || !near(i.Strength, 30, 1e-9) || i.About != "用户" {
		t.Errorf("written back: episode %+v\nlesson %+v\nimpression %+v", e, l, i)
	}
	if got, _ := s.Sources(ctx, e.ID); !reflect.DeepEqual(got, []string{f1, f2, f3}) {
		t.Errorf("the episode is built on %v", got)
	}
	// The fragments are part of the episode now. They stay in the record and
	// leave ordinary recall.
	for _, f := range []string{f1, f2, f3} {
		if m := get(t, s, f); m.State != StateAbsorbed || m.StateBy != e.ID || m.Pending || m.Body == "" {
			t.Errorf("fragment after the round: %+v", m)
		}
	}
	if got := searchIDs(t, s, "alphadetail"); len(got) != 0 {
		t.Errorf("an ordinary search still finds the absorbed fragment: %v", got)
	}
	if got := search(t, s, "alphadetail", true); !reflect.DeepEqual(got, []string{f1}) {
		t.Errorf("a deep search should still reach the fragment, got %v", got)
	}
	recent := recentIDs(t, s)
	if len(recent) != 4 || has(recent, f1) || !has(recent, e.ID) || !has(recent, alone) {
		t.Errorf("recent after the round: %v", recent)
	}
	if c, _ := s.TierCounts(ctx, 4); c.Total() != 4 {
		t.Errorf("counts after the round: %+v, want the episode, lesson, impression and the lone fragment", c)
	}

	// The fragment that was passed over has been dealt with. It leaves
	// ordinary recall after half the base strength, unless it comes to mind.
	if m := get(t, s, alone); m.Pending || !m.Live() || m.ArchiveAt != 9 || m.FadeAt != 9 {
		t.Errorf("passed fragment: pending %v, fades at %v, archived at %v; want false, 9, 9", m.Pending, m.FadeAt, m.ArchiveAt)
	}
	if n, _ := s.PendingCount(ctx); n != 0 {
		t.Errorf("pending after the round = %d", n)
	}
	replays(t, s)

	other := remember(t, s, t0, sess.ID, "又一件小事", "正文")
	reflectOn(t, s, sess.ID, nil, other)
	fill(t, s, sess.ID, 4)
	listed(t, s, other)
	fill(t, s, sess.ID, 1)
	now := clock(t, s) // 10
	if a, b := get(t, s, alone), get(t, s, other); a.Tier(now) != TierArchived || b.Tier(now) != TierActive || !near(b.ArchiveAt, 9+archiveAfter, 1e-5) {
		t.Errorf("six memories on: the passed fragment is %s, the one that came to mind is %s", a.Tier(now), b.Tier(now))
	}
	replays(t, s)
}

func TestReflectIsAllOrNothing(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	f1 := remember(t, s, t0, sess.ID, "第一件事", "正文")
	f2 := remember(t, s, t0, sess.ID, "第二件事", "正文")
	batch := begin(t, s, sess.ID)

	_, err := s.FinishReflect(ctx, t0, sess.ID, batch, []Entry{ent(KindEpisode, "合起来的经历", f1, f2), ent(KindLesson, "一条经验", "m_nothing")}, nil)
	var ee *EntryError
	if !errors.As(err, &ee) || ee.Index != 1 || !strings.Contains(ee.Error(), "entry 2") || !strings.Contains(ee.Error(), "m_nothing") {
		t.Fatalf("err = %v, want the second entry refused by name", err)
	}
	if memories, _, _ := s.Counts(ctx); memories != 2 || !get(t, s, f1).Pending {
		t.Errorf("a refused round changed the memory: %d memories", memories)
	}
	// The round is still open: the same batch can be written back once it is right.
	if _, err := s.FinishReflect(ctx, t0, sess.ID, batch, []Entry{ent(KindEpisode, "合起来的经历", f1, f2)}, nil); err != nil {
		t.Errorf("writing the corrected round back: %v", err)
	}
	// And then it is closed.
	if _, err := s.FinishReflect(ctx, t0, sess.ID, batch, nil, []string{f1}); !errors.Is(err, ErrNoBatch) {
		t.Errorf("writing the same batch back twice: %v, want %v", err, ErrNoBatch)
	}
}

func TestOneRoundOfReflectionAtATime(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	a := session(t, s, t0, "", "phone")
	b := session(t, s, t0, "", "desktop")
	f := remember(t, s, t0, a.ID, "一件事", "正文")
	hold := 15 * time.Minute

	first, _, err := s.BeginReflect(ctx, t0, a.ID, hold)
	if err != nil {
		t.Fatal(err)
	}
	// While it runs, another conversation cannot start one, and is told until when.
	_, until, err := s.BeginReflect(ctx, t0.Add(5*time.Minute), b.ID, hold)
	if !errors.Is(err, ErrReflectBusy) || !until.Equal(t0.Add(hold)) {
		t.Fatalf("second session: err = %v, until %v; want busy until %v", err, until, t0.Add(hold))
	}
	if _, err := s.FinishReflect(ctx, t0, b.ID, first, nil, []string{f}); !errors.Is(err, ErrNoBatch) {
		t.Errorf("writing back another session's batch: %v", err)
	}
	// The same conversation may start over; its earlier batch is void.
	second, _, err := s.BeginReflect(ctx, t0.Add(6*time.Minute), a.ID, hold)
	if err != nil || second == first {
		t.Fatalf("same session again: %q, %v", second, err)
	}
	if _, err := s.FinishReflect(ctx, t0, a.ID, first, nil, []string{f}); !errors.Is(err, ErrNoBatch) {
		t.Errorf("writing back a batch that was started over: %v", err)
	}
	// A round that is never written back runs out, and then another may start.
	third, _, err := s.BeginReflect(ctx, t0.Add(6*time.Minute+hold+time.Second), b.ID, hold)
	if err != nil {
		t.Fatalf("after the round ran out: %v", err)
	}
	if _, err := s.FinishReflect(ctx, t0, a.ID, second, nil, []string{f}); !errors.Is(err, ErrNoBatch) {
		t.Errorf("writing back after another session took over: %v", err)
	}
	if _, err := s.FinishReflect(ctx, t0, b.ID, third, nil, []string{f}); err != nil {
		t.Errorf("the session holding the round: %v", err)
	}
	if _, _, err := s.BeginReflect(ctx, t0, "s_nothing", hold); !errors.Is(err, ErrNoSession) {
		t.Errorf("a round without a session: %v", err)
	}
	// A round is working state. It leaves nothing in the log but its result.
	var kinds string
	if err := s.r.QueryRow(`SELECT group_concat(kind, ' ') FROM (SELECT kind FROM events ORDER BY seq)`).Scan(&kinds); err != nil || kinds != "session session remember reflect" {
		t.Errorf("events: %q (err %v)", kinds, err)
	}
}

func TestWhatAnEntryMayRestOn(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "", "cli")
	f1 := remember(t, s, t0, sess.ID, "片段一", "正文")
	f2 := remember(t, s, t0, sess.ID, "片段二", "正文")
	retracted := remember(t, s, t0, sess.ID, "被撤销的片段", "正文")
	erased := remember(t, s, t0, sess.ID, "被删除的片段", "正文")
	old := remember(t, s, t0, sess.ID, "被更正的片段", "正文")
	amend(t, s, sess.ID, AmendRetract, retracted, 0)
	if _, err := s.Erase(ctx, t0, sess.ID, erased, ""); err != nil {
		t.Fatal(err)
	}
	fixed, err := s.Correct(ctx, t0, old, RememberInput{SessionID: sess.ID, Moment: "other", Source: "lived", Importance: 0.5, Gist: "更正后的片段", Body: "正文"})
	if err != nil {
		t.Fatal(err)
	}
	ep := reflectOn(t, s, sess.ID, []Entry{ent(KindEpisode, "一段经历", f1)})[0]

	for name, tc := range map[string]struct {
		entry Entry
		want  string
	}{
		"nothing to rest on":            {ent(KindLesson, "经验"), "from is required"},
		"an unknown memory":             {ent(KindLesson, "经验", "m_nothing"), "names no memory"},
		"a retracted memory":            {ent(KindLesson, "经验", retracted), "retracted"},
		"an erased memory":              {ent(KindLesson, "经验", erased), "erased"},
		"a replaced memory":             {ent(KindLesson, "经验", old), "build on the correction"},
		"episode from an absorbed one":  {ent(KindEpisode, "经历", f1, f2), "not part of one yet"},
		"episode from an episode":       {ent(KindEpisode, "经历", ep), "put together from fragments"},
		"a reading of nothing":          {Entry{Kind: KindReading, Gist: "新的理解", Ref: "m_nothing"}, "names no memory"},
		"a reading of an erased memory": {Entry{Kind: KindReading, Gist: "新的理解", Ref: erased}, "erased"},
	} {
		if got := refused(t, s, sess.ID, tc.entry); !strings.Contains(got, tc.want) {
			t.Errorf("%s: refused with %q, want it to say %q", name, got, tc.want)
		}
	}
	// A lesson may rest on an episode, on a fragment that is part of one, and
	// on a correction.
	ids := reflectOn(t, s, sess.ID, []Entry{ent(KindLesson, "经验", ep, f1, fixed)})
	if got, _ := s.Sources(ctx, ids[0]); len(got) != 3 {
		t.Errorf("the lesson is built on %v", got)
	}
}

func TestStatementsAboutOneself(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	a := session(t, s, t0, "model-a", "cli")
	b := session(t, s, t0, "model-a", "cli")
	a1 := remember(t, s, t0, a.ID, "我先问清了需求再动手", "正文")
	a2 := remember(t, s, t0, a.ID, "我又一次先问清了需求", "正文")
	a3 := remember(t, s, t0, a.ID, "我第三次先问清了需求", "正文")
	b1 := remember(t, s, t0, b.ID, "另一次对话里我也先问清了需求", "正文")
	told := rememberWith(t, s, RememberInput{SessionID: b.ID, Source: "told", Gist: "用户说我做事很谨慎", Body: "他的原话。"})
	self := func(gist, ref string, from ...string) Entry {
		return Entry{Kind: KindSelf, Gist: gist, Context: "做设计的时候", Importance: 0.5, From: from, Ref: ref}
	}

	for name, tc := range map[string]struct {
		entry Entry
		want  string
	}{
		"two experiences":             {self("我动手前会先问清楚", "", a1, b1), "at least 3 experiences"},
		"three from one conversation": {self("我动手前会先问清楚", "", a1, a2, a3), "this rests on 3 from 1"},
		"what someone said about me":  {self("我做事很谨慎", "", a1, b1, told), "told or inferred"},
	} {
		if got := refused(t, s, a.ID, tc.entry); !strings.Contains(got, tc.want) {
			t.Errorf("%s: refused with %q, want it to say %q", name, got, tc.want)
		}
	}

	id := reflectOn(t, s, a.ID, []Entry{self("我动手前会先问清楚", "", a1, a2, b1)})[0]
	m := get(t, s, id)
	if m.Kind != KindSelf || !m.Core || m.Context != "做设计的时候" || m.Source != "lived" || m.Model != "model-a" || m.Tier(1000) != TierCore {
		t.Errorf("the statement: %+v", m)
	}
	selves, _ := s.Selves(ctx)
	if len(selves) != 1 || selves[0].ID != id {
		t.Errorf("statements that stand: %v", selves)
	}
	// It is loaded whole at the start of a session, not searched for or listed.
	if has(recentIDs(t, s), id) || has(searchIDs(t, s, "动手前会先问清楚"), id) || has(search(t, s, "动手前会先问清楚", true), id) {
		t.Error("a statement about oneself shows up in lists or searches")
	}
	if core, _ := s.Core(ctx, 10); len(core) != 0 {
		t.Errorf("core list holds %d memories, want the statement left out of it", len(core))
	}
	if c, _ := s.TierCounts(ctx, clock(t, s)); c.Total() != 5 {
		t.Errorf("counts: %+v, want the five fragments", c)
	}

	// Revising it takes new experiences, not the same ones again.
	if got := refused(t, s, b.ID, self("我有时不问就动手", id, a1, a2, a3)); !strings.Contains(got, "this adds 1") {
		t.Errorf("revision on old evidence: %q", got)
	}
	if got := refused(t, s, b.ID, self("改写", a1, a3, b1)); !strings.Contains(got, "not a statement about yourself") {
		t.Errorf("revision of something that is not a statement: %q", got)
	}
	c1 := remember(t, s, t0, b.ID, "这次我没问就动手了，结果返工", "正文")
	revised := reflectOn(t, s, b.ID, []Entry{self("我多数时候先问清楚，赶时间时会跳过", id, a3, c1)})[0]
	if was := get(t, s, id); was.State != StateSuperseded || was.StateBy != revised || was.Gist != "我动手前会先问清楚" {
		t.Errorf("the earlier statement: %+v; want it kept, marked as replaced", was)
	}
	if now := get(t, s, revised); now.Ref != id || !now.Live() {
		t.Errorf("the revision: %+v", now)
	}
	if selves, _ := s.Selves(ctx); len(selves) != 1 || selves[0].ID != revised {
		t.Errorf("statements that stand after the revision: %d", len(selves))
	}
	replays(t, s)
}

func TestSeparateOccasionsAreCountedThroughEpisodesAndRecords(t *testing.T) {
	s := newStore(t)
	a := session(t, s, t0, "", "cli")
	b := session(t, s, t0, "", "cli")
	p1 := remember(t, s, t0, a.ID, "第一次对话的片段", "正文")
	p2 := remember(t, s, t0, b.ID, "第二次对话的片段", "正文")
	x := remember(t, s, t0, a.ID, "同一次对话的另一件事", "正文")
	y := remember(t, s, t0, a.ID, "同一次对话的第三件事", "正文")
	ep := reflectOn(t, s, a.ID, []Entry{ent(KindEpisode, "跨两次对话的一段经历", p1, p2)})[0]
	// The episode was written in one conversation, but it is made of two.
	reflectOn(t, s, a.ID, []Entry{{Kind: KindSelf, Gist: "我会把事情跟到底", Importance: 0.5, From: []string{ep, x, y}}})

	// What is reconstructed from records is all written in one conversation.
	// There the day it happened tells the occasions apart.
	day := func(n int, gist string) string {
		return rememberWith(t, s, RememberInput{SessionID: a.ID, Source: SourceReconstructed, Gist: gist, Body: "正文", Happened: t0.AddDate(0, 0, -n)})
	}
	r1, r2, r3 := day(30, "旧记录一"), day(30, "旧记录二"), day(30, "旧记录三")
	if got := refused(t, s, a.ID, Entry{Kind: KindSelf, Gist: "我一直如此", Importance: 0.5, From: []string{r1, r2, r3}}); !strings.Contains(got, "from 1") {
		t.Errorf("three records of one day: %q", got)
	}
	r4 := day(10, "旧记录四")
	reflectOn(t, s, a.ID, []Entry{{Kind: KindSelf, Gist: "我一直如此", Importance: 0.5, From: []string{r1, r2, r4}}})
}

func TestImpressionsAndReadings(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	sess := session(t, s, t0, "model-a", "cli")
	f1 := remember(t, s, t0, sess.ID, "用户第一次纠正我", "正文")
	f2 := remember(t, s, t0, sess.ID, "用户夸了我", "正文")
	about := func(gist, from string) Entry {
		e := ent(KindImpression, gist, from)
		e.About = "用户"
		return e
	}
	first := reflectOn(t, s, sess.ID, []Entry{about("严格", f1)})[0]
	second := reflectOn(t, s, sess.ID, []Entry{about("严格，也不吝称赞", f2)})[0]
	// The newer impression takes the place of the older; both are kept.
	if was := get(t, s, first); was.State != StateSuperseded || was.StateBy != second {
		t.Errorf("the earlier impression: %+v", was)
	}
	got, _ := s.Impressions(ctx, []string{"用户", "别人"})
	if len(got) != 1 || got[0].ID != second {
		t.Errorf("current impressions: %v", got)
	}

	// A later understanding hangs on the memory and leaves it as it was.
	later := session(t, s, t0.Add(time.Hour), "model-b", "cli")
	before := get(t, s, f1)
	rid := reflectOn(t, s, later.ID, []Entry{{Kind: KindReading, Gist: "我现在不理解当时为什么没有先问", Ref: f1, Importance: 0.5}})[0]
	after := get(t, s, f1)
	after.Pending, before.Pending = false, false
	if !reflect.DeepEqual(before, after) {
		t.Errorf("a reading changed the memory it reads\nbefore %+v\nafter  %+v", before, after)
	}
	readings, _ := s.Readings(ctx, f1)
	if len(readings) != 1 || readings[0].ID != rid || readings[0].Model != "model-b" || readings[0].Ref != f1 || readings[0].Source != "inferred" {
		t.Errorf("readings of the memory: %+v", readings)
	}
	if has(recentIDs(t, s), rid) || len(searchIDs(t, s, "不理解")) != 0 {
		t.Error("a reading shows up in lists or searches on its own")
	}
	replays(t, s)
}
