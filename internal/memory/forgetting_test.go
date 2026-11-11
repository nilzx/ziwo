package memory

import (
	"context"
	"testing"
	"time"

	"github.com/nilzx/ziwo/internal/store"
)

const day = 24 * time.Hour

func (f *fixture) rememberWith(in store.RememberInput) string {
	f.t.Helper()
	id, _, _, err := f.svc.Remember(context.Background(), RememberRequest{RememberInput: in, Client: "test", Conn: "conn-1"})
	if err != nil {
		f.t.Fatalf("remember %q: %v", in.Gist, err)
	}
	f.clock.Advance(time.Minute)
	return id
}

func (f *fixture) expand(id string) Result {
	f.t.Helper()
	rs, err := f.svc.Expand(context.Background(), []string{id}, "conn-1")
	if err != nil || len(rs) != 1 {
		f.t.Fatalf("expand %s: %v, %d results", id, err, len(rs))
	}
	return rs[0]
}

func tiers(rs []Result) map[string]store.Tier {
	out := make(map[string]store.Tier, len(rs))
	for _, r := range rs {
		out[r.ID] = r.Tier
	}
	return out
}

func TestFadedMemoryIsFoundByGistAndRestoredByDeepRecall(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	f.clock.Advance(40 * day) // faded: past day 36, before day 90
	if rs := f.recall("年糕"); len(rs) != 0 {
		t.Fatalf("an ordinary recall searched the details of a faded memory: %v", ids(rs))
	}
	if got := f.get(id).RecallCount; got != 0 {
		t.Fatalf("a recall that found nothing was counted: %d", got)
	}

	rs := f.deepRecall("年糕")
	if len(rs) != 1 || rs[0].ID != id || rs[0].Tier != store.TierFaded {
		t.Fatalf("deep recall = %v, want the faded memory", tiers(rs))
	}
	f.sync()
	m := f.get(id)
	if m.Tier(f.clock.Now()) != store.TierActive || m.RecallCount != 1 || !(m.Strength > 30) {
		t.Errorf("after the deep recall: tier %s, count %d, strength %.1f; want active, 1, more than 30", m.Tier(f.clock.Now()), m.RecallCount, m.Strength)
	}
	if rs := f.recall("年糕"); len(rs) != 1 || rs[0].Tier != store.TierActive {
		t.Errorf("once restored, its details are searched again: %v", tiers(rs))
	}
}

func TestFadedGistStillComesToMind(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	f.clock.Advance(40 * day)
	rs := f.recall("猫")
	if len(rs) != 1 || rs[0].ID != id || rs[0].Tier != store.TierFaded {
		t.Fatalf("recall on a gist word = %v, want the memory, marked faded", tiers(rs))
	}
	// Coming to mind is itself a recall: it is active again afterwards.
	f.sync()
	if got := f.get(id).Tier(f.clock.Now()); got != store.TierActive {
		t.Errorf("after coming to mind: %s, want active", got)
	}
}

func TestArchivedMemoryNeedsDeepRecallAndIsEmbeddedAgain(t *testing.T) {
	emb := &topicEmbedder{}
	f := start(t, tempDB(t), emb)
	cat := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")
	core := f.rememberWith(store.RememberInput{Gist: "用户第一次把部署交给我", Body: "上线很顺利。", Importance: 0.95})
	f.sync()
	if f.svc.Indexed() != 2 {
		t.Fatalf("indexed = %d, want 2", f.svc.Indexed())
	}

	f.clock.Advance(100 * day) // past day 90: archived
	// Before the sweep its vector is still in the index; it must not come back
	// through it.
	if rs := f.recall("feline"); len(rs) != 0 {
		t.Fatalf("an archived memory came back through its vector: %v", tiers(rs))
	}
	f.sync() // sweeps
	if f.svc.Indexed() != 1 {
		t.Errorf("indexed after the sweep = %d, want only the core memory", f.svc.Indexed())
	}
	if rs := f.recall("猫"); len(rs) != 0 {
		t.Errorf("an ordinary recall reached an archived memory: %v", tiers(rs))
	}
	if rs := f.recall("deploy"); len(rs) != 1 || rs[0].ID != core || rs[0].Tier != store.TierCore {
		t.Errorf("the core memory must still be found by meaning: %v", tiers(rs))
	}

	rs := f.deepRecall("年糕")
	if len(rs) != 1 || rs[0].ID != cat || rs[0].Tier != store.TierArchived {
		t.Fatalf("deep recall = %v, want the archived memory", tiers(rs))
	}
	f.sync() // records the recall, then embeds it again
	if f.svc.Indexed() != 2 {
		t.Errorf("indexed after it was recalled = %d, want 2", f.svc.Indexed())
	}
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != cat || rs[0].Tier != store.TierActive {
		t.Errorf("restored memory by meaning: %v", tiers(rs))
	}
}

func TestExpandCountsAsRecall(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	f.clock.Advance(100 * day)
	r := f.expand(id)
	if r.Tier != store.TierArchived || r.Body != "一只橘猫，名字叫年糕。" {
		t.Fatalf("expand of an archived memory: tier %s, body %q; want it in full, marked archived", r.Tier, r.Body)
	}
	f.sync()
	m := f.get(id)
	if m.Tier(f.clock.Now()) != store.TierActive || m.RecallCount != 1 {
		t.Errorf("after expand: tier %s, count %d; want active, 1", m.Tier(f.clock.Now()), m.RecallCount)
	}
}

func TestRelevanceLeadsOverImportanceAndFreshness(t *testing.T) {
	f := start(t, tempDB(t), nil)
	// Old and unimportant, but it is what the question is about.
	target := f.rememberWith(store.RememberInput{Importance: 0.2,
		Gist: "反向代理把请求全部拒绝了", Body: "查了一个小时才发现是 Host 头的问题。"})
	f.clock.Advance(10 * day)
	// Fresh and important, and it shares one common phrase with the question.
	bystander := f.rememberWith(store.RememberInput{Importance: 0.85,
		Gist: "用户说这个项目对他很重要", Body: "他把请求列成了清单。"})
	f.remember("用户问了天气", "聊了几句。")

	rs := f.recall("反向代理为什么拒绝请求")
	if len(rs) == 0 || rs[0].ID != target {
		t.Fatalf("order = %v, want the relevant memory (%s) first", ids(rs), target)
	}
	for _, r := range rs {
		if r.ID == bystander {
			// Being returned would strengthen it for a question it does not answer.
			t.Errorf("a memory that only shares a common phrase was returned: %v", ids(rs))
		}
	}
	f.sync()
	if got := f.get(bystander).RecallCount; got != 0 {
		t.Errorf("the bystander was strengthened: recall count %d", got)
	}
}

func TestRetentionBreaksTies(t *testing.T) {
	f := start(t, tempDB(t), nil)
	first := f.remember("第一次部署：一样的正文", "一样的正文")
	second := f.remember("第二次部署：一样的正文", "一样的正文")

	// Thirty days on, only the first is brought back to mind.
	f.clock.Advance(30 * day)
	if rs := f.recall("第一次"); len(rs) != 1 || rs[0].ID != first {
		t.Fatalf("setup recall = %v, want only the first", ids(rs))
	}
	f.sync()

	// Equal matches and equal importance: the better retained one comes
	// first, although the other is the newer of the two.
	rs := f.recall("一样的正文")
	if got := ids(rs); len(got) != 2 || got[0] != first || got[1] != second {
		t.Errorf("order = %v, want the recently recalled one (%s) first", got, first)
	}
}

func TestContextShowsCoreFirstAndCountsTiers(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	core := f.rememberWith(store.RememberInput{Gist: "第一次被信任", Body: "用户把整个项目交给了我。", Importance: 0.95})
	old := f.remember("很久以前的小事", "正文")
	f.clock.Advance(40 * day)
	faded := old
	recent := f.remember("刚发生的事", "正文")
	f.clock.Advance(time.Hour)

	view, err := f.svc.Context(ctx, "model-a", "desktop", "c1")
	if err != nil {
		t.Fatal(err)
	}
	if want := (store.TierCounts{Core: 1, Active: 1, Faded: 1}); view.Counts != want {
		t.Errorf("counts = %+v, want %+v", view.Counts, want)
	}
	if len(view.Core) != 1 || view.Core[0].ID != core {
		t.Errorf("core list = %d memories, want the one core memory", len(view.Core))
	}
	if len(view.Recent) != 2 || view.Recent[0].ID != recent || view.Recent[1].ID != faded {
		t.Fatalf("recent list = %d memories, want the new one then the faded one, without the core one", len(view.Recent))
	}
	if view.Recent[1].Tier(view.Now) != store.TierFaded {
		t.Errorf("the old memory should show as faded")
	}

	// Being shown at the start of a session is not a recall.
	f.sync()
	if got := f.get(faded); got.RecallCount != 0 || got.Tier(f.clock.Now()) != store.TierFaded {
		t.Errorf("get_context strengthened a memory: count %d, tier %s", got.RecallCount, got.Tier(f.clock.Now()))
	}

	// Much later only the core memory is left to show.
	f.clock.Advance(1000 * day)
	view, err = f.svc.Context(ctx, "model-a", "desktop", "c2")
	if err != nil {
		t.Fatal(err)
	}
	if want := (store.TierCounts{Core: 1, Archived: 2}); view.Counts != want || len(view.Recent) != 0 || len(view.Core) != 1 {
		t.Errorf("much later: counts %+v, %d recent, %d core", view.Counts, len(view.Recent), len(view.Core))
	}
}
