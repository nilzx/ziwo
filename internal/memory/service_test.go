package memory

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nilzx/ziwo/internal/embed"
	"github.com/nilzx/ziwo/internal/store"
)

// topicEmbedder stands in for an embedding model. Each text is placed on the
// axes of the topics it mentions, so texts about the same topic are close
// even when they share no words, and gets a small component on an axis of its
// own, so texts about no known topic are close to nothing. It checks the
// plumbing, not search quality.
type topicEmbedder struct {
	mu     sync.Mutex
	down   bool
	refuse string // texts containing this are rejected, as an over-long input would be
	calls  int
}

var topics = [][]string{
	{"猫", "cat", "feline", "kitten"},
	{"部署", "上线", "deploy", "release"},
	{"纠正", "误解", "corrected", "misunderstood"},
}

const ownAxes = 1024

func (e *topicEmbedder) Model() string { return "topic-test" }

func (e *topicEmbedder) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.calls
}

func (e *topicEmbedder) Embed(ctx context.Context, kind embed.Kind, texts []string) ([][]float32, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls++
	if e.down {
		return nil, errors.New("connection refused")
	}
	out := make([][]float32, len(texts))
	for i, text := range texts {
		if e.refuse != "" && strings.Contains(text, e.refuse) {
			return nil, errors.New("input is too large")
		}
		v := make([]float32, len(topics)+ownAxes)
		h := fnv.New32a()
		h.Write([]byte(text))
		v[len(topics)+int(h.Sum32()%ownAxes)] = 0.05
		lower := strings.ToLower(text)
		for axis, words := range topics {
			for _, w := range words {
				if strings.Contains(lower, w) {
					v[axis] = 1
				}
			}
		}
		out[i] = v
	}
	return out, nil
}

func (e *topicEmbedder) set(down bool, refuse string) {
	e.mu.Lock()
	e.down, e.refuse = down, refuse
	e.mu.Unlock()
}

// testClock is a wall clock the test moves by hand. The service's background
// workers read it too, so it is locked.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// testParams makes an ordinary memory fade once 13 newer ones are written and
// leave ordinary recall once 30 are, so tests need tens of memories, not
// hundreds.
func testParams() store.Params {
	p := store.DefaultParams()
	p.BaseStrength = 10
	return p
}

type fixture struct {
	t       *testing.T
	path    string
	st      *store.Store
	svc     *Service
	clock   *testClock
	session string // the conversation the fixture writes in; started on first use
	fillers int
}

func start(t *testing.T, path string, emb embed.Embedder) *fixture {
	t.Helper()
	f := &fixture{t: t, path: path, clock: &testClock{t: time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)}}
	st, err := store.Open(context.Background(), path, store.Options{Params: testParams(), Create: true})
	if err != nil {
		t.Fatal(err)
	}
	f.st = st
	svc, err := New(context.Background(), st, emb, Config{Now: f.clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	f.svc = svc
	t.Cleanup(f.stop)
	return f
}

func (f *fixture) stop() {
	if f.svc != nil {
		f.svc.Close()
		f.st.Close()
		f.svc = nil
	}
}

func (f *fixture) begin(model, client string) ContextView {
	f.t.Helper()
	view, err := f.svc.Context(context.Background(), model, client)
	if err != nil {
		f.t.Fatalf("get context: %v", err)
	}
	return view
}

func (f *fixture) sess() string {
	f.t.Helper()
	if f.session == "" {
		f.session = f.begin("model-a", "test").Session.ID
	}
	return f.session
}

func (f *fixture) rememberWith(in store.RememberInput) string {
	f.t.Helper()
	if in.SessionID == "" {
		in.SessionID = f.sess()
	}
	id, dup, err := f.svc.Remember(context.Background(), in)
	if err != nil || dup {
		f.t.Fatalf("remember %q: err=%v dup=%v", in.Gist, err, dup)
	}
	f.clock.Advance(time.Minute)
	return id
}

func (f *fixture) remember(gist, body string) string {
	f.t.Helper()
	return f.rememberWith(store.RememberInput{Gist: gist, Body: body})
}

// fill lives through n more ordinary moments. Their text shares nothing with
// what the tests search for.
func (f *fixture) fill(n int) {
	f.t.Helper()
	for i := 0; i < n; i++ {
		f.fillers++
		f.remember(fmt.Sprintf("filler %d", f.fillers), "padding")
	}
}

func (f *fixture) sync() {
	f.t.Helper()
	if err := f.svc.Sync(context.Background()); err != nil {
		f.t.Fatalf("sync: %v", err)
	}
}

func (f *fixture) recall(query string) []Result {
	f.t.Helper()
	rs, err := f.svc.Recall(context.Background(), query, 0, false, f.sess())
	if err != nil {
		f.t.Fatalf("recall %q: %v", query, err)
	}
	return rs
}

func (f *fixture) deepRecall(query string) []Result {
	f.t.Helper()
	rs, err := f.svc.Recall(context.Background(), query, 0, true, f.sess())
	if err != nil {
		f.t.Fatalf("deep recall %q: %v", query, err)
	}
	return rs
}

func (f *fixture) expand(id string) Result {
	f.t.Helper()
	rs, err := f.svc.Expand(context.Background(), []string{id}, f.sess())
	if err != nil || len(rs) != 1 {
		f.t.Fatalf("expand %s: %v, %d results", id, err, len(rs))
	}
	return rs[0]
}

// get reads a memory without it counting as coming to mind.
func (f *fixture) get(id string) store.Memory {
	f.t.Helper()
	ms, err := f.st.Get(context.Background(), []string{id})
	if err != nil || len(ms) != 1 {
		f.t.Fatalf("get %s: %v, %d memories", id, err, len(ms))
	}
	return ms[0]
}

// lived is the experience clock: how many memories have been written.
func (f *fixture) lived() int64 {
	f.t.Helper()
	c, err := f.st.Clock(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	return c
}

func (f *fixture) tier(id string) store.Tier {
	f.t.Helper()
	return f.get(id).Tier(f.lived())
}

func (f *fixture) counts() store.TierCounts {
	f.t.Helper()
	c, err := f.st.TierCounts(context.Background(), f.lived())
	if err != nil {
		f.t.Fatal(err)
	}
	return c
}

func ids(rs []Result) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.ID
	}
	return out
}

func tempDB(t *testing.T) string { return filepath.Join(t.TempDir(), "test.ziwo") }

// distinct returns n different short strings.
func distinct(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("x%d", i)
	}
	return out
}

func TestRecallByKeywordAndByMeaning(t *testing.T) {
	f := start(t, tempDB(t), &topicEmbedder{})
	cat := f.remember("用户给我看了他的猫", "一只橘猫，叫年糕。")
	deploy := f.remember("第一次部署出了问题", "反向代理拒绝了所有请求。")
	f.remember("用户问了天气", "聊了几句就结束了。")
	f.sync()
	if got := f.svc.Indexed(); got != 3 {
		t.Fatalf("indexed = %d, want 3", got)
	}

	// No word in common with the memory: only the meaning can find it.
	rs := f.recall("feline")
	if len(rs) != 1 || rs[0].ID != cat || !rs[0].ByMeaning || rs[0].ByKeyword {
		t.Errorf("recall by meaning = %+v, want only the cat memory, by meaning", rs)
	}

	// A word in the body that the stand-in model knows nothing about: only
	// the keyword index can find it.
	rs = f.recall("反向代理")
	if len(rs) != 1 || rs[0].ID != deploy || !rs[0].ByKeyword || rs[0].ByMeaning {
		t.Errorf("recall by keyword = %+v, want only the deploy memory, by keyword", rs)
	}

	// Found both ways: counted once.
	rs = f.recall("部署")
	if len(rs) != 1 || rs[0].ID != deploy || !rs[0].ByKeyword || !rs[0].ByMeaning {
		t.Errorf("recall both ways = %+v, want the deploy memory once, found both ways", rs)
	}

	if rs := f.recall("量子力学"); len(rs) != 0 {
		t.Errorf("unrelated query returned %v", ids(rs))
	}
}

func TestRecallRanksAgreementAboveASingleSignal(t *testing.T) {
	f := start(t, tempDB(t), &topicEmbedder{})
	meaningOnly := f.remember("The kitten knocked over my notes", "Nothing else happened.")
	both := f.remember("用户的猫生病了", "他很担心，我陪他查了资料。")
	f.sync()

	rs := f.recall("猫")
	if got := ids(rs); len(got) != 2 || got[0] != both || got[1] != meaningOnly {
		t.Errorf("order = %v, want %s then %s", got, both, meaningOnly)
	}
}

func TestImportanceBreaksTies(t *testing.T) {
	f := start(t, tempDB(t), nil)
	minor := f.rememberWith(store.RememberInput{Gist: "小事：一样的正文", Body: "一样的正文", Importance: 0.4})
	major := f.rememberWith(store.RememberInput{Gist: "大事：一样的正文", Body: "一样的正文", Importance: 0.85})

	// Keyword rank puts one of them first by a hair; importance has to outweigh that.
	rs := f.recall("一样的正文")
	if got := ids(rs); len(got) != 2 || got[0] != major || got[1] != minor {
		t.Errorf("order = %v, want the important one (%s) first", got, major)
	}
}

func TestRecallFallsBackToKeywordsWhenEmbeddingFails(t *testing.T) {
	emb := &topicEmbedder{}
	f := start(t, tempDB(t), emb)
	deploy := f.remember("第一次部署出了问题", "反向代理拒绝了所有请求。")
	f.sync()

	emb.set(true, "")
	rs := f.recall("部署")
	if len(rs) != 1 || rs[0].ID != deploy || rs[0].ByMeaning {
		t.Errorf("with the embedder down: %+v, want the memory by keyword only", rs)
	}

	// A memory written while the embedder is down is searchable by keyword at
	// once, and by meaning once the embedder is back.
	cat := f.remember("用户给我看了他的猫", "一只橘猫。")
	if rs := f.recall("橘猫"); len(rs) != 1 || rs[0].ID != cat {
		t.Errorf("keyword search right after writing: %v", ids(rs))
	}
	emb.set(false, "")
	f.sync()
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != cat {
		t.Errorf("after the embedder came back: %v, want the cat memory", ids(rs))
	}
}

func TestOneRefusedMemoryDoesNotBlockTheRest(t *testing.T) {
	emb := &topicEmbedder{}
	f := start(t, tempDB(t), emb)
	emb.set(false, "毒丸")
	poison := f.remember("毒丸", "嵌入服务不接受这一条。")
	cat := f.remember("用户给我看了他的猫", "一只橘猫。")
	f.sync()

	if got := f.svc.Indexed(); got != 1 {
		t.Errorf("indexed = %d, want 1", got)
	}
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != cat {
		t.Errorf("recall by meaning = %v, want the cat memory", ids(rs))
	}
	if rs := f.recall("毒丸"); len(rs) != 1 || rs[0].ID != poison {
		t.Errorf("the refused memory must stay findable by keyword, got %v", ids(rs))
	}
}

func TestVectorsSurviveRestartAndBacklogIsPickedUp(t *testing.T) {
	path := tempDB(t)
	emb := &topicEmbedder{}
	f := start(t, path, emb)
	cat := f.remember("用户给我看了他的猫", "一只橘猫。")
	f.sync()
	emb.set(true, "")
	deploy := f.remember("第一次部署出了问题", "反向代理拒绝了所有请求。") // never embedded in this run
	f.stop()

	emb.set(false, "")
	before := emb.count()
	f2 := start(t, path, emb)
	if got := f2.svc.Indexed(); got < 1 {
		t.Fatalf("indexed right after restart = %d, want the stored vector loaded", got)
	}
	f2.sync()
	if got := f2.svc.Indexed(); got != 2 {
		t.Errorf("indexed after catching up = %d, want 2", got)
	}
	if rs := f2.recall("kitten"); len(rs) != 1 || rs[0].ID != cat {
		t.Errorf("recall cat = %v", ids(rs))
	}
	if rs := f2.recall("release"); len(rs) != 1 || rs[0].ID != deploy {
		t.Errorf("recall deploy = %v", ids(rs))
	}
	if emb.count() == before {
		t.Error("the backlog was not embedded after restart")
	}
}

func TestWritesNeedASession(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()

	for name, session := range map[string]string{"no session id": "", "blank": "  ", "an id that names nothing": "s_nope"} {
		_, _, err := f.svc.Remember(ctx, store.RememberInput{SessionID: session, Gist: "g", Body: "b"})
		// The message is what the model sees: it has to say what to do.
		if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "get_context") {
			t.Errorf("%s: err = %v, want ErrInvalid pointing at get_context", name, err)
		}
	}
	if total, events, _ := f.st.Counts(ctx); total != 0 || events != 0 {
		t.Errorf("refused writes left %d memories and %d events behind", total, events)
	}

	// The session id is all that ties a write to its conversation: the same
	// id from anywhere lands in the same session, with that session's carrier.
	a := f.begin("model-a", "phone").Session.ID
	b := f.begin("model-b", "desktop").Session.ID
	one := f.rememberWith(store.RememberInput{SessionID: a, Gist: "在手机上发生的事", Body: "正文"})
	two := f.rememberWith(store.RememberInput{SessionID: b, Gist: "在桌面端发生的事", Body: "正文"})
	if m := f.get(one); m.SessionID != a || m.Model != "model-a" || m.Client != "phone" {
		t.Errorf("first memory: session %s as %s via %s", m.SessionID, m.Model, m.Client)
	}
	if m := f.get(two); m.SessionID != b || m.Model != "model-b" || m.Client != "desktop" {
		t.Errorf("second memory: session %s as %s via %s", m.SessionID, m.Model, m.Client)
	}
}

func TestReadsDoNotNeedASession(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	id := f.remember("用户纠正了我", "我理解偏了。")

	for _, session := range []string{"", "s_nope"} {
		if rs, err := f.svc.Recall(ctx, "纠正", 0, false, session); err != nil || len(rs) != 1 {
			t.Errorf("recall with session %q: %v, %d results", session, err, len(rs))
		}
		if rs, err := f.svc.Expand(ctx, []string{id}, session); err != nil || len(rs) != 1 {
			t.Errorf("expand with session %q: %v, %d results", session, err, len(rs))
		}
	}
	f.sync()
	if got := f.get(id).RecallCount; got != 4 {
		t.Errorf("times it came to mind = %d, want 4", got)
	}
}

func TestBeingListedIsRecordedButDoesNotStrengthen(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户纠正了我", "我理解偏了。")
	f.fill(5)
	f.recall("纠正")
	f.recall("纠正")
	f.sync()

	if m := f.get(id); m.RecallCount != 2 || m.Strength != 10 || m.TouchedOrd != 6 || m.ReadOrd != 1 {
		t.Errorf("after two listings: count %d, strength %v, touched at %d, read at %d; want 2, 10, 6, 1",
			m.RecallCount, m.Strength, m.TouchedOrd, m.ReadOrd)
	}
}

func TestNewSessionIsToldOfOtherRecentOnes(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	others := func(v ContextView) []string {
		out := make([]string, len(v.Others))
		for i, o := range v.Others {
			out[i] = o.ID
		}
		return out
	}
	same := func(got []string, want ...string) bool {
		return len(got) == len(want) && strings.Join(got, ",") == strings.Join(want, ",")
	}

	a := f.begin("model-a", "phone") // minute 0
	if len(a.Others) != 0 {
		t.Errorf("the first session was told of others: %v", others(a))
	}
	f.clock.Advance(5 * time.Minute)
	b := f.begin("model-a", "desktop") // minute 5
	if !same(others(b), a.Session.ID) || b.Others[0].Client != "phone" || !b.Others[0].LastActiveAt.Equal(a.Now) {
		t.Errorf("second session: others = %+v, want the first one, via phone", b.Others)
	}

	// Writing keeps a session active. One that has been silent for longer
	// than the window is not mentioned.
	f.clock.Advance(25 * time.Minute)
	f.rememberWith(store.RememberInput{SessionID: a.Session.ID, Gist: "手机上继续聊", Body: "正文"}) // minute 30
	f.clock.Advance(9 * time.Minute)
	c := f.begin("model-a", "cli") // minute 40
	if !same(others(c), a.Session.ID) {
		t.Errorf("third session: others = %v, want only the one that wrote ten minutes ago", others(c))
	}

	// Reading keeps a session active too.
	f.clock.Advance(20 * time.Minute) // minute 60
	if _, err := f.svc.Recall(ctx, "手机", 0, false, b.Session.ID); err != nil {
		t.Fatal(err)
	}
	f.sync()
	f.clock.Advance(time.Minute)
	d := f.begin("model-a", "web") // minute 61
	if !same(others(d), b.Session.ID) {
		t.Errorf("fourth session: others = %v, want only the one that searched a minute ago", others(d))
	}

	f.clock.Advance(3 * time.Hour)
	e := f.begin("model-a", "web")
	if len(e.Others) != 0 {
		t.Errorf("hours later: others = %v, want none", others(e))
	}

	// At most three are listed, the most recently active first.
	var recent []string
	for i := 0; i < 4; i++ {
		f.clock.Advance(time.Minute)
		recent = append(recent, f.begin("model-a", "web").Session.ID)
	}
	f.clock.Advance(time.Minute)
	last := f.begin("model-a", "web")
	if !same(others(last), recent[3], recent[2], recent[1]) {
		t.Errorf("with five others active: %v, want the three most recent, newest first", others(last))
	}
}

func TestContextShowsRecentMemoriesAndNewCarriers(t *testing.T) {
	f := start(t, tempDB(t), nil)

	view := f.begin("model-a", "desktop")
	if view.Counts.Total() != 0 || len(view.Recent) != 0 || view.Carrier.First || view.Session.ID == "" {
		t.Errorf("empty memory: %+v", view)
	}
	f.session = view.Session.ID
	var last string
	for i := 0; i < 10; i++ {
		last = f.remember("第 "+string(rune('一'+i))+" 件事", "正文")
	}

	view = f.begin("model-b", "cli")
	if view.Counts.Active != 10 || view.Clock != 10 || len(view.Recent) != 8 || view.Recent[0].ID != last {
		t.Errorf("active=%d clock=%d recent=%d first=%s, want 10, 10, 8, %s",
			view.Counts.Active, view.Clock, len(view.Recent), view.Recent[0].ID, last)
	}
	if !view.Carrier.First || len(view.Carrier.Earlier) != 1 || view.Carrier.Earlier[0] != "model-a" {
		t.Errorf("carrier note = %+v, want model-b flagged as new after model-a", view.Carrier)
	}
	if view.Session.ID == f.session {
		t.Error("two calls to get_context returned the same session")
	}
}

func TestRememberValidation(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	long := func(n int) string { return strings.Repeat("字", n) }
	sess := f.sess()

	for name, in := range map[string]store.RememberInput{
		"no gist":         {Body: "b"},
		"no body":         {Gist: "g"},
		"blank gist":      {Gist: "  \n", Body: "b"},
		"gist too long":   {Gist: long(MaxGistRunes + 1), Body: "b"},
		"body too long":   {Gist: "g", Body: long(MaxBodyRunes + 1)},
		"lesson too long": {Gist: "g", Body: "b", Lesson: long(MaxFieldRunes + 1)},
		"bad moment":      {Gist: "g", Body: "b", Moment: "tuesday"},
		"bad source":      {Gist: "g", Body: "b", Source: "dreamed"},
		"importance > 1":  {Gist: "g", Body: "b", Importance: 1.5},
		"importance < 0":  {Gist: "g", Body: "b", Importance: -0.1},
		"intensity > 1":   {Gist: "g", Body: "b", Feeling: "f", Intensity: 1.2},
		"intensity alone": {Gist: "g", Body: "b", Intensity: 0.5},
		"too many people": {Gist: "g", Body: "b", People: distinct(MaxPeople + 1)},
	} {
		in.SessionID = sess
		if _, _, err := f.svc.Remember(ctx, in); !errors.Is(err, ErrInvalid) || strings.Contains(err.Error(), "session") {
			t.Errorf("%s: err = %v, want ErrInvalid about that field", name, err)
		}
	}
	if total, events, _ := f.st.Counts(ctx); total != 0 || events != 1 {
		t.Errorf("rejected input left %d memories and %d events behind; want 0 and the session alone", total, events)
	}

	// Limits are counted in characters, not bytes, and defaults are filled in.
	id, _, err := f.svc.Remember(ctx, store.RememberInput{SessionID: "  " + sess + " ",
		Gist: "  " + long(MaxGistRunes) + "  ", Body: long(MaxBodyRunes), People: []string{" 年糕 ", "", "年糕"},
	})
	if err != nil {
		t.Fatalf("input at the limits was rejected: %v", err)
	}
	m := f.get(id)
	if m.Moment != "other" || m.Source != "lived" || m.Importance != 0.5 || len(m.People) != 1 || m.People[0] != "年糕" || m.Gist != long(MaxGistRunes) {
		t.Errorf("defaults: moment=%s source=%s importance=%v people=%v", m.Moment, m.Source, m.Importance, m.People)
	}

	if _, err := f.svc.Recall(ctx, "  ", 0, false, ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("blank query: err = %v", err)
	}
	if _, err := f.svc.Expand(ctx, nil, ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("no ids: err = %v", err)
	}
	if _, err := f.svc.Expand(ctx, distinct(MaxExpand+1), ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("too many ids: err = %v", err)
	}
}
