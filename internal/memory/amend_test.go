package memory

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nilzx/ziwo/internal/store"
)

func (f *fixture) amend(req AmendRequest) string {
	f.t.Helper()
	if req.SessionID == "" {
		req.SessionID = f.sess()
	}
	msg, err := f.svc.Amend(context.Background(), req)
	if err != nil {
		f.t.Fatalf("amend %s %s: %v", req.Action, req.ID, err)
	}
	return msg
}

// refusedAmend returns the message of an amendment that must be turned down
// as a mistake the model can fix.
func (f *fixture) refusedAmend(req AmendRequest) string {
	f.t.Helper()
	msg, err := f.svc.Amend(context.Background(), req)
	if !errors.Is(err, ErrInvalid) {
		f.t.Fatalf("amend %+v: %q, %v; want it refused as invalid input", req, msg, err)
	}
	return err.Error()
}

func TestRetractAndEraseLeaveRecallAtOnce(t *testing.T) {
	f := start(t, tempDB(t), &topicEmbedder{})
	cat := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")
	kitten := f.remember("The kitten knocked over my notes", "Nothing else happened.")
	f.sync()

	// Set aside: gone from recall by keyword and by meaning before any sweep.
	if msg := f.amend(AmendRequest{Action: "retract", ID: cat, Reason: "用户说这个不用记"}); !strings.Contains(msg, "restore") {
		t.Errorf("retract says %q, want it to mention how to undo it", msg)
	}
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != kitten {
		t.Errorf("after retract, recall by meaning = %v, want only the other memory", ids(rs))
	}
	if rs := f.deepRecall("年糕"); len(rs) != 0 {
		t.Errorf("a retracted memory was recalled: %v", ids(rs))
	}
	// It can still be read by id, marked for what it is, and that is not a recall.
	if r := f.expand(cat); !r.Retracted || r.Body == "" {
		t.Errorf("expand of a retracted memory: %+v", r.Memory)
	}
	f.sync()
	if got := f.get(cat).RecallCount; got != 0 {
		t.Errorf("reading a retracted memory counted as coming to mind: %d", got)
	}

	f.amend(AmendRequest{Action: "restore", ID: cat})
	f.sync()
	if rs := f.recall("feline"); len(rs) != 2 {
		t.Errorf("after restore, recall by meaning = %v, want both", ids(rs))
	}

	// Erased: gone for good, from the index too.
	before := f.svc.Indexed()
	if msg := f.amend(AmendRequest{Action: "erase", ID: cat, Reason: "用户让我删掉"}); !strings.Contains(msg, "gone for good") {
		t.Errorf("erase says %q", msg)
	}
	if f.svc.Indexed() != before-1 {
		t.Errorf("indexed went from %d to %d on erase", before, f.svc.Indexed())
	}
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != kitten {
		t.Errorf("after erase, recall by meaning = %v", ids(rs))
	}
	if r := f.expand(cat); r.State != store.StateErased || r.Gist != "" || r.Body != "" {
		t.Errorf("expand of an erased memory: %+v", r.Memory)
	}
	if got := f.refusedAmend(AmendRequest{SessionID: f.sess(), Action: "pin", ID: cat}); !strings.Contains(got, "erased") {
		t.Errorf("pin of an erased memory: %q", got)
	}
}

func TestCorrectCarriesOverWhatWasNotWrong(t *testing.T) {
	f := start(t, tempDB(t), nil)
	old := f.rememberWith(store.RememberInput{Gist: "用户的猫叫年糕", Body: "一只橘猫，很亲人。", Outcome: "聊得很开心",
		People: []string{"用户"}, Importance: 0.7, Moment: "emotion", Feeling: "喜欢", Intensity: 0.4})
	f.clock.Advance(72 * time.Hour)

	msg := f.amend(AmendRequest{Action: "correct", ID: old, Gist: "用户的猫叫汤圆", Reason: "用户说我记错了名字"})
	rs := f.recall("橘猫")
	if len(rs) != 1 || rs[0].ID == old || !strings.Contains(msg, rs[0].ID) || !strings.Contains(msg, old) {
		t.Fatalf("after the correction recall = %v, message %q", ids(rs), msg)
	}
	is := rs[0]
	if is.Gist != "用户的猫叫汤圆" || is.Body != "一只橘猫，很亲人。" || is.Outcome != "聊得很开心" || is.Importance != 0.7 ||
		is.Moment != "emotion" || is.Feeling != "喜欢" || !reflect.DeepEqual(is.People, []string{"用户"}) || is.Corrects != old {
		t.Errorf("the correction: %+v", is.Memory)
	}
	// It is still a memory of the day it happened.
	if was := f.get(old); !is.CreatedAt.Equal(was.CreatedAt) || !is.WrittenAt.After(is.CreatedAt) || was.StateBy != is.ID {
		t.Errorf("dates: happened %v, written %v; old happened %v", is.CreatedAt, is.WrittenAt, was.CreatedAt)
	}
	if rs := f.deepRecall("橘猫"); len(rs) != 2 {
		t.Errorf("deep recall = %v, want both versions", ids(rs))
	}

	for name, tc := range map[string]struct {
		req  AmendRequest
		want string
	}{
		"nothing to say instead":  {AmendRequest{Action: "correct", ID: is.ID}, "what to say instead"},
		"already replaced":        {AmendRequest{Action: "correct", ID: old, Gist: "x"}, is.ID},
		"a gist that is too long": {AmendRequest{Action: "correct", ID: is.ID, Gist: strings.Repeat("字", MaxGistRunes+1)}, "gist is"},
		"unknown memory":          {AmendRequest{Action: "retract", ID: "m_nothing"}, "no memory with id"},
		"unknown action":          {AmendRequest{Action: "polish", ID: is.ID}, "action must be one of"},
		"no id":                   {AmendRequest{Action: "pin"}, "id is required"},
		"reweigh to nothing":      {AmendRequest{Action: "reweigh", ID: is.ID}, "importance is required"},
		"reweigh out of range":    {AmendRequest{Action: "reweigh", ID: is.ID, Importance: 1.5}, "importance is required"},
		"a reason that is a text": {AmendRequest{Action: "pin", ID: is.ID, Reason: strings.Repeat("字", MaxReasonRunes+1)}, "reason is"},
		"prefer without a rule":   {AmendRequest{Action: "prefer"}, "text is required"},
		"unprefer of nothing":     {AmendRequest{Action: "unprefer", ID: "p_nothing"}, "no preference in force"},
	} {
		tc.req.SessionID = f.sess()
		if got := f.refusedAmend(tc.req); !strings.Contains(got, tc.want) {
			t.Errorf("%s: refused with %q, want it to say %q", name, got, tc.want)
		}
	}
	for name, session := range map[string]string{"no session": "", "unknown session": "s_nope"} {
		if got := f.refusedAmend(AmendRequest{SessionID: session, Action: "pin", ID: is.ID}); !strings.Contains(got, "get_context") {
			t.Errorf("%s: refused with %q, want it to point at get_context", name, got)
		}
	}
	if f.get(is.ID).Pinned {
		t.Error("a refused amendment took effect")
	}
}

func TestPreferencesAreLoadedWithTheContext(t *testing.T) {
	f := start(t, tempDB(t), nil)
	msg := f.amend(AmendRequest{Action: "prefer", Text: "  不用记天气之类的闲聊  ", Reason: "用户说的"})
	view := f.begin("model-a", "cli")
	if len(view.Prefs) != 1 || view.Prefs[0].Text != "不用记天气之类的闲聊" || !strings.Contains(msg, view.Prefs[0].ID) {
		t.Fatalf("preferences in the context: %+v; message %q", view.Prefs, msg)
	}
	f.amend(AmendRequest{Action: "unprefer", ID: view.Prefs[0].ID})
	if view = f.begin("model-a", "cli"); len(view.Prefs) != 0 {
		t.Errorf("after unprefer: %+v", view.Prefs)
	}
	for i := 0; i < MaxPreferences; i++ {
		f.amend(AmendRequest{Action: "prefer", Text: "规则 " + distinct(MaxPreferences)[i]})
	}
	if got := f.refusedAmend(AmendRequest{SessionID: f.sess(), Action: "prefer", Text: "再来一条"}); !strings.Contains(got, "already") {
		t.Errorf("one preference too many: %q", got)
	}
}

func TestReconstructedMemoriesNeedADate(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	f.fill(3)
	past := f.clock.Now().AddDate(0, -6, 0)
	base := store.RememberInput{SessionID: f.sess(), Gist: "半年前和用户做的一个项目", Body: "从旧会话记录里整理出来的。", Pointer: "~/.claude/projects/x/abc.jsonl"}

	for name, tc := range map[string]struct {
		source string
		when   time.Time
		want   string
	}{
		"no date":                  {store.SourceReconstructed, time.Time{}, "happened_at is required"},
		"a date in the future":     {store.SourceReconstructed, f.clock.Now().Add(48 * time.Hour), "in the future"},
		"a date on a lived memory": {"lived", past, "goes with source"},
		"a date on a told memory":  {"told", past, "goes with source"},
	} {
		in := base
		in.Source, in.Happened = tc.source, tc.when
		if _, _, err := f.svc.Remember(ctx, in); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want one saying %q", name, err, tc.want)
		}
	}

	in := base
	in.Source, in.Happened = store.SourceReconstructed, past
	id, _, err := f.svc.Remember(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	m := f.get(id)
	if !m.CreatedAt.Equal(past) || !m.WrittenAt.Equal(f.clock.Now()) || m.Source != store.SourceReconstructed || f.lived() != 3 || f.tier(id) != store.TierActive {
		t.Errorf("reconstructed memory: happened %v, written %v, source %s, clock %d, tier %s", m.CreatedAt, m.WrittenAt, m.Source, f.lived(), f.tier(id))
	}
	if rs := f.recall("半年前"); len(rs) != 1 || rs[0].ID != id {
		t.Errorf("recall of the reconstructed memory: %v", ids(rs))
	}

	for in, want := range map[string]string{"2026-03-14": "2026-03-14T00:00:00Z", " 2026-03-14T09:30:00+08:00 ": "2026-03-14T01:30:00Z", "2026-03-14 09:30": "2026-03-14T09:30:00Z"} {
		if got, err := ParseWhen(in); err != nil || got.Format(time.RFC3339) != want {
			t.Errorf("ParseWhen(%q) = %v, %v; want %s", in, got, err, want)
		}
	}
	if _, err := ParseWhen("last spring"); !errors.Is(err, ErrInvalid) {
		t.Errorf("ParseWhen of words: %v", err)
	}
}

func TestReflectThroughTheService(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	a := f.sess()
	f1 := f.rememberWith(store.RememberInput{Gist: "用户让我做一个记忆系统", Body: "一开始我理解成了项目笔记本。", People: []string{"用户"}})
	f2 := f.remember("用户纠正了我的理解", "他说要记的是经历。")
	f3 := f.remember("用户问了天气", "聊了几句。")
	b := f.begin("model-a", "desktop").Session.ID

	if view := f.begin("model-a", "cli"); view.Pending != 3 || len(view.Selves) != 0 {
		t.Errorf("before reflecting: pending %d, %d statements", view.Pending, len(view.Selves))
	}
	view, err := f.svc.BeginReflect(ctx, a, 2)
	if err != nil || view.Batch == "" || len(view.Fragments) != 2 || view.Remaining != 1 || view.Fragments[0].Body == "" {
		t.Fatalf("begin: %+v, %v", view, err)
	}
	// One round at a time, and the other conversation is told why and for how long.
	if _, err := f.svc.BeginReflect(ctx, b, 0); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "another conversation is reflecting") || !strings.Contains(err.Error(), "15 min") {
		t.Errorf("a second conversation: %v", err)
	}

	episode := store.Entry{Kind: store.KindEpisode, Gist: "我和用户把记忆系统的方向定了下来", Body: "先理解偏了，被纠正后改了设计。", From: []string{f1, f2}, Milestone: true}
	for name, tc := range map[string]struct {
		entries []store.Entry
		want    string
	}{
		"an unknown kind":           {[]store.Entry{{Kind: "dream", Gist: "g"}}, "kind must be one of"},
		"an episode without a body": {[]store.Entry{{Kind: store.KindEpisode, Gist: "g", From: []string{f1}}}, "body is required"},
		"an impression of nobody":   {[]store.Entry{{Kind: store.KindImpression, Gist: "g", From: []string{f1}}}, "about is required"},
		"a reading of nothing":      {[]store.Entry{{Kind: store.KindReading, Gist: "g"}}, "ref is required"},
		"a feeling made up":         {[]store.Entry{{Kind: store.KindLesson, Gist: "g", Body: "b", From: []string{f1}, Intensity: 0.8}}, "needs a feeling"},
		"too many entries":          {make([]store.Entry, MaxEntries+1), "at most"},
		"resting on nothing known":  {[]store.Entry{episode, {Kind: store.KindLesson, Gist: "g", Body: "b", From: []string{"m_nothing"}}}, "entry 2"},
		"nothing at all":            {nil, "nothing to write back"},
	} {
		_, err := f.svc.FinishReflect(ctx, a, view.Batch, tc.entries, nil)
		if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want one saying %q", name, err, tc.want)
		}
	}
	if _, err := f.svc.FinishReflect(ctx, a, "b_nothing", []store.Entry{episode}, nil); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "is not open") {
		t.Errorf("a batch that is not open: %v", err)
	}
	if f.get(f1).State != "" {
		t.Fatal("a refused round changed the memory")
	}

	made, err := f.svc.FinishReflect(ctx, a, view.Batch, []store.Entry{episode}, []string{f3, " "})
	if err != nil || len(made) != 1 {
		t.Fatalf("finish: %v, %v", made, err)
	}
	ep := f.expand(made[0])
	if ep.Kind != store.KindEpisode || !ep.Milestone || !ep.Core || !reflect.DeepEqual(ep.Sources, []string{f1, f2}) || ep.Importance != 0.5 {
		t.Errorf("the episode read back: %+v, built on %v", ep.Memory, ep.Sources)
	}
	if r := f.expand(f1); r.State != store.StateAbsorbed || r.StateBy != made[0] {
		t.Errorf("a fragment after the round: %+v", r.Memory)
	}
	after := f.begin("model-a", "cli")
	if after.Pending != 0 || len(after.Core) != 1 || after.Core[0].ID != made[0] || after.Counts.Total() != 2 {
		t.Errorf("after reflecting: pending %d, core %d, counts %+v", after.Pending, len(after.Core), after.Counts)
	}
	// The round is over, so the other conversation may start one. There is
	// nothing left to reflect on, and so no batch.
	if view, err := f.svc.BeginReflect(ctx, b, 0); err != nil || view.Batch != "" || len(view.Fragments) != 0 {
		t.Errorf("with nothing pending: %+v, %v", view, err)
	}
	if _, err := f.svc.BeginReflect(ctx, "s_nope", 0); !errors.Is(err, ErrInvalid) {
		t.Errorf("a round without a known session: %v", err)
	}

	// A later understanding is shown with the memory it reads.
	f.remember("又过了一阵", "正文")
	view, err = f.svc.BeginReflect(ctx, b, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.FinishReflect(ctx, b, view.Batch, []store.Entry{{Kind: store.KindReading, Gist: "现在看，当时的误解来自我没有先问", Ref: made[0]}}, nil); err != nil {
		t.Fatal(err)
	}
	if r := f.expand(made[0]); len(r.Readings) != 1 || r.Readings[0].Ref != made[0] {
		t.Errorf("readings shown with the episode: %+v", r.Readings)
	}
}

// The vectors of fragments that went into an episode are dropped by the next
// sweep. Until then they must not bring the fragments back.
func TestAbsorbedFragmentsLeaveRecallByMeaningAtOnce(t *testing.T) {
	f := start(t, tempDB(t), &topicEmbedder{})
	ctx := context.Background()
	a := f.remember("用户给我看了他的猫", "一只橘猫。")
	b := f.remember("The kitten knocked over my notes", "Nothing else happened.")
	f.sync()
	view, err := f.svc.BeginReflect(ctx, f.sess(), 0)
	if err != nil {
		t.Fatal(err)
	}
	made, err := f.svc.FinishReflect(ctx, f.sess(), view.Batch,
		[]store.Entry{{Kind: store.KindEpisode, Gist: "和用户的猫相处的一个下午", Body: "先看了照片，后来它打翻了我的笔记。", From: []string{a, b}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range f.recall("feline") {
		if r.ID == a || r.ID == b {
			t.Errorf("an absorbed fragment came back through its vector: %s", r.Gist)
		}
	}
	f.sync()
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != made[0] || !rs[0].ByMeaning {
		t.Errorf("recall by meaning after the round = %v, want only the episode", ids(rs))
	}
	if got, want := f.svc.Indexed(), 1; got != want {
		t.Errorf("indexed = %d, want only the episode", got)
	}
}
