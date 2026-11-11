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

// testClock is a clock the test moves by hand. The service's background
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

type fixture struct {
	t     *testing.T
	path  string
	st    *store.Store
	svc   *Service
	clock *testClock
}

func start(t *testing.T, path string, emb embed.Embedder) *fixture {
	t.Helper()
	f := &fixture{t: t, path: path, clock: &testClock{t: time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)}}
	st, err := store.Open(context.Background(), path, store.DefaultParams())
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

func (f *fixture) remember(gist, body string) string {
	f.t.Helper()
	id, _, _, err := f.svc.Remember(context.Background(), RememberRequest{
		RememberInput: store.RememberInput{Gist: gist, Body: body},
		Client:        "test", Conn: "conn-1",
	})
	if err != nil {
		f.t.Fatalf("remember %q: %v", gist, err)
	}
	f.clock.Advance(time.Minute)
	return id
}

func (f *fixture) sync() {
	f.t.Helper()
	if err := f.svc.Sync(context.Background()); err != nil {
		f.t.Fatalf("sync: %v", err)
	}
}

func (f *fixture) recall(query string) []Result {
	f.t.Helper()
	rs, err := f.svc.Recall(context.Background(), query, 0, false, "conn-1")
	if err != nil {
		f.t.Fatalf("recall %q: %v", query, err)
	}
	return rs
}

func (f *fixture) deepRecall(query string) []Result {
	f.t.Helper()
	rs, err := f.svc.Recall(context.Background(), query, 0, true, "conn-1")
	if err != nil {
		f.t.Fatalf("deep recall %q: %v", query, err)
	}
	return rs
}

// get reads a memory without it counting as a recall.
func (f *fixture) get(id string) store.Memory {
	f.t.Helper()
	ms, err := f.st.Get(context.Background(), []string{id})
	if err != nil || len(ms) != 1 {
		f.t.Fatalf("get %s: %v, %d memories", id, err, len(ms))
	}
	return ms[0]
}

func ids(rs []Result) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.ID
	}
	return out
}

func tempDB(t *testing.T) string { return filepath.Join(t.TempDir(), "ziwo.db") }

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
	ctx := context.Background()
	write := func(gist string, importance float64) string {
		id, _, _, err := f.svc.Remember(ctx, RememberRequest{
			RememberInput: store.RememberInput{Gist: gist, Body: "一样的正文", Importance: importance},
		})
		if err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(time.Minute)
		return id
	}
	minor := write("小事：一样的正文", 0.1)
	major := write("大事：一样的正文", 1)

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

func TestRecallIsRecorded(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户纠正了我", "我理解偏了。")
	f.recall("纠正")
	f.recall("纠正")
	f.sync()

	if got := f.get(id).RecallCount; got != 2 {
		t.Errorf("recall count = %d, want 2", got)
	}
}

func TestSessionResolution(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	write := func(req RememberRequest) string {
		t.Helper()
		req.Gist, req.Body = "第 "+f.clock.Now().Format(time.TimeOnly)+" 条", "正文"
		_, session, _, err := f.svc.Remember(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(time.Minute)
		return session
	}

	view, err := f.svc.Context(ctx, "model-a", "desktop", "conn-a")
	if err != nil {
		t.Fatal(err)
	}
	a := view.Session.ID

	if got := write(RememberRequest{Client: "desktop", Conn: "conn-a"}); got != a {
		t.Errorf("same connection: session %s, want %s", got, a)
	}
	if got := write(RememberRequest{Client: "cli", Conn: "conn-b", RememberInput: store.RememberInput{SessionID: a}}); got != a {
		t.Errorf("explicit session id: session %s, want %s", got, a)
	}
	// A new connection from the same client soon after: same conversation, as far as can be told.
	if got := write(RememberRequest{Client: "desktop", Conn: "conn-c"}); got != a {
		t.Errorf("same client within the window: session %s, want %s", got, a)
	}
	// Another client that never called get_context gets a session of its own.
	web := write(RememberRequest{Client: "web", Conn: "conn-d"})
	if web == a {
		t.Errorf("a different client was attached to session %s", a)
	}
	if got := write(RememberRequest{Client: "web", Conn: "conn-d"}); got != web {
		t.Errorf("second write on that connection: session %s, want %s", got, web)
	}
	// Long after, with no connection to go by: a new session.
	f.clock.Advance(2 * SessionWindow)
	if got := write(RememberRequest{Client: "desktop"}); got == a {
		t.Errorf("after the window: still session %s", a)
	}

	_, _, _, err = f.svc.Remember(ctx, RememberRequest{RememberInput: store.RememberInput{
		Gist: "g", Body: "b", SessionID: "s_nope"}})
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown session id: err = %v, want ErrInvalid", err)
	}
}

func TestContextShowsRecentMemoriesAndNewCarriers(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()

	view, err := f.svc.Context(ctx, "model-a", "desktop", "c1")
	if err != nil {
		t.Fatal(err)
	}
	if view.Counts.Total() != 0 || len(view.Recent) != 0 || view.Carrier.First {
		t.Errorf("empty memory: %+v", view)
	}
	var last string
	for i := 0; i < 10; i++ {
		last = f.remember("第 "+string(rune('一'+i))+" 件事", "正文")
	}

	view, err = f.svc.Context(ctx, "model-b", "cli", "c2")
	if err != nil {
		t.Fatal(err)
	}
	if view.Counts.Active != 10 || len(view.Recent) != 8 || view.Recent[0].ID != last {
		t.Errorf("active=%d recent=%d first=%s, want 10, 8, %s", view.Counts.Active, len(view.Recent), view.Recent[0].ID, last)
	}
	if !view.Carrier.First || len(view.Carrier.Earlier) != 1 || view.Carrier.Earlier[0] != "model-a" {
		t.Errorf("carrier note = %+v, want model-b flagged as new after model-a", view.Carrier)
	}
}

func TestRememberValidation(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	long := func(n int) string { return strings.Repeat("字", n) }

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
		if _, _, _, err := f.svc.Remember(ctx, RememberRequest{RememberInput: in}); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	if total, events, _ := f.st.Counts(ctx); total != 0 || events != 0 {
		t.Errorf("rejected input left %d memories and %d events behind", total, events)
	}

	// Limits are counted in characters, not bytes, and defaults are filled in.
	id, _, _, err := f.svc.Remember(ctx, RememberRequest{RememberInput: store.RememberInput{
		Gist: "  " + long(MaxGistRunes) + "  ", Body: long(MaxBodyRunes), People: []string{" 年糕 ", "", "年糕"},
	}})
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
