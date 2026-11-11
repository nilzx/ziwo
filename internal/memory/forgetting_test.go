package memory

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/nilzx/ziwo/internal/store"
)

func tiers(rs []Result) map[string]store.Tier {
	out := make(map[string]store.Tier, len(rs))
	for _, r := range rs {
		out[r.ID] = r.Tier
	}
	return out
}

func TestTimeAloneForgetsNothing(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	// Ten years with nothing lived through: nothing has moved.
	f.clock.Advance(10 * 365 * 24 * time.Hour)
	if got := f.tier(id); got != store.TierActive {
		t.Fatalf("ten years later: %s, want active", got)
	}
	if rs := f.recall("年糕"); len(rs) != 1 || rs[0].Tier != store.TierActive {
		t.Errorf("ten years later its details are still searched: %v", tiers(rs))
	}

	// The same memory, one busy afternoon later.
	f2 := start(t, tempDB(t), nil)
	id2 := f2.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")
	f2.fill(15)
	if got := f2.tier(id2); got != store.TierFaded {
		t.Errorf("fifteen memories later: %s, want faded", got)
	}
}

func TestFadedMemoryIsFoundByGistAndBroughtBackByDeepRecall(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	f.fill(15) // faded: past 13 newer memories, before 30
	if rs := f.recall("年糕"); len(rs) != 0 {
		t.Fatalf("an ordinary recall searched the details of a faded memory: %v", ids(rs))
	}
	f.sync()
	if m := f.get(id); m.RecallCount != 0 || m.TouchedOrd != 1 {
		t.Fatalf("a recall that found nothing was counted: count %d, touched at %d", m.RecallCount, m.TouchedOrd)
	}

	rs := f.deepRecall("年糕")
	if len(rs) != 1 || rs[0].ID != id || rs[0].Tier != store.TierFaded {
		t.Fatalf("deep recall = %v, want the faded memory", tiers(rs))
	}
	f.sync()
	// Listed, not read: within reach again, and no stronger than before.
	if m := f.get(id); f.tier(id) != store.TierActive || m.RecallCount != 1 || m.Strength != 10 {
		t.Errorf("after the deep recall: tier %s, count %d, strength %v; want active, 1, 10", f.tier(id), m.RecallCount, m.Strength)
	}
	if rs := f.recall("年糕"); len(rs) != 1 || rs[0].Tier != store.TierActive {
		t.Errorf("once back, its details are searched again: %v", tiers(rs))
	}
}

func TestFadedGistStillComesToMind(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	f.fill(15)
	rs := f.recall("猫")
	if len(rs) != 1 || rs[0].ID != id || rs[0].Tier != store.TierFaded {
		t.Fatalf("recall on a gist word = %v, want the memory, marked faded", tiers(rs))
	}
	// Coming to mind restarts its decay: it is active again afterwards.
	f.sync()
	if got := f.tier(id); got != store.TierActive {
		t.Errorf("after coming to mind: %s, want active", got)
	}
}

func TestReadingInFullStrengthens(t *testing.T) {
	f := start(t, tempDB(t), nil)
	listed := f.remember("只被搜到的事", "正文甲")
	read := f.remember("搜到后又读了全文的事", "正文乙")
	f.fill(20)

	// The usual sequence: a search lists it, then it is read in full.
	if rs := f.recall("搜到"); len(rs) != 2 {
		t.Fatalf("setup recall = %v, want both", ids(rs))
	}
	f.sync()
	r := f.expand(read)
	if r.Body != "正文乙" || r.Tier != store.TierActive {
		t.Fatalf("expand: body %q, tier %s", r.Body, r.Tier)
	}
	f.sync()

	a, b := f.get(listed), f.get(read)
	// Twenty memories lay between writing it and reading it.
	want := 10 * (1 + 2*(1-math.Exp(-2.0)))
	if a.Strength != 10 || math.Abs(b.Strength-want) > 1e-6 {
		t.Errorf("strengths: listed %v, read %.4f; want 10 and %.4f", a.Strength, b.Strength, want)
	}
	if a.RecallCount != 1 || b.RecallCount != 2 {
		t.Errorf("times they came to mind: %d and %d, want 1 and 2", a.RecallCount, b.RecallCount)
	}

	// The stronger one outlasts the other.
	f.fill(20)
	if f.tier(listed) != store.TierFaded || f.tier(read) != store.TierActive {
		t.Errorf("twenty memories on: listed is %s, read is %s; want faded and active", f.tier(listed), f.tier(read))
	}
}

func TestExpandReachesArchivedMemories(t *testing.T) {
	f := start(t, tempDB(t), nil)
	id := f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。")

	f.fill(40)
	r := f.expand(id)
	if r.Tier != store.TierArchived || r.Body != "一只橘猫，名字叫年糕。" {
		t.Fatalf("expand of an archived memory: tier %s, body %q; want it in full, marked archived", r.Tier, r.Body)
	}
	f.sync()
	if m := f.get(id); f.tier(id) != store.TierActive || m.RecallCount != 1 || !(m.Strength > 25) {
		t.Errorf("after expand: tier %s, count %d, strength %.2f; want active, 1, nearly tripled", f.tier(id), m.RecallCount, m.Strength)
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
	// After a sync, exactly the memories that are not archived have a vector.
	indexedRight := func(when string) {
		t.Helper()
		c := f.counts()
		if got, want := f.svc.Indexed(), int(c.Total()-c.Archived); got != want {
			t.Errorf("%s: indexed = %d, want the %d memories that are not archived", when, got, want)
		}
	}

	f.fill(35) // past 30 newer memories: archived
	if got := f.tier(cat); got != store.TierArchived {
		t.Fatalf("after 35 newer memories: %s, want archived", got)
	}
	// Before the sweep its vector is still in the index; it must not come back
	// through it.
	if rs := f.recall("feline"); len(rs) != 0 {
		t.Fatalf("an archived memory came back through its vector: %v", tiers(rs))
	}
	f.sync() // sweeps
	indexedRight("after the sweep")
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
	before := f.svc.Indexed()
	f.sync() // records that it came to mind, then embeds it again
	if f.svc.Indexed() != before+1 {
		t.Errorf("indexed went from %d to %d when the memory came back, want one more", before, f.svc.Indexed())
	}
	indexedRight("after it came back")
	if rs := f.recall("feline"); len(rs) != 1 || rs[0].ID != cat || rs[0].Tier != store.TierActive {
		t.Errorf("the memory that came back, by meaning: %v", tiers(rs))
	}
}

func TestRelevanceLeadsOverImportanceAndFreshness(t *testing.T) {
	f := start(t, tempDB(t), nil)
	// Older and unimportant, but it is what the question is about.
	target := f.rememberWith(store.RememberInput{Importance: 0.3,
		Gist: "反向代理把请求全部拒绝了", Body: "查了一个小时才发现是 Host 头的问题。"})
	f.fill(2)
	// Fresh and important, and it shares one common phrase with the question.
	bystander := f.rememberWith(store.RememberInput{Importance: 0.85,
		Gist: "用户说这个项目对他很重要", Body: "他把请求列成了清单。"})
	f.remember("用户问了天气", "聊了几句。")
	if got := f.tier(target); got != store.TierActive {
		t.Fatalf("setup: the target is %s, want active", got)
	}

	rs := f.recall("反向代理为什么拒绝请求")
	if len(rs) == 0 || rs[0].ID != target {
		t.Fatalf("order = %v, want the relevant memory (%s) first", ids(rs), target)
	}
	for _, r := range rs {
		if r.ID == bystander {
			// Being listed would restart its decay for a question it does not answer.
			t.Errorf("a memory that only shares a common phrase was returned: %v", ids(rs))
		}
	}
	f.sync()
	if got := f.get(bystander).RecallCount; got != 0 {
		t.Errorf("the bystander was counted as coming to mind: %d", got)
	}
}

func TestRetentionBreaksTies(t *testing.T) {
	f := start(t, tempDB(t), nil)
	first := f.remember("第一次部署：一样的正文", "一样的正文")
	second := f.remember("第二次部署：一样的正文", "一样的正文")

	// Eight memories on, only the first is brought back to mind.
	f.fill(8)
	if rs := f.recall("第一次"); len(rs) != 1 || rs[0].ID != first {
		t.Fatalf("setup recall = %v, want only the first", ids(rs))
	}
	f.sync()

	// Equal matches and equal importance: the better retained one comes
	// first, although the other is the newer of the two.
	rs := f.recall("一样的正文")
	if got := ids(rs); len(got) != 2 || got[0] != first || got[1] != second {
		t.Errorf("order = %v, want the one that just came to mind (%s) first", got, first)
	}
}

func TestContextShowsCoreFirstAndCountsTiers(t *testing.T) {
	f := start(t, tempDB(t), nil)
	ctx := context.Background()
	core := f.rememberWith(store.RememberInput{Gist: "第一次被信任", Body: "用户把整个项目交给了我。", Importance: 0.95})
	old := f.remember("很久以前的小事", "正文")
	f.fill(14)
	recent := f.remember("刚发生的事", "正文")

	// 17 memories: the core one, the 13 newest still active, 3 faded.
	view := f.begin("model-a", "desktop")
	if want := (store.TierCounts{Core: 1, Active: 13, Faded: 3}); view.Counts != want || view.Clock != 17 {
		t.Errorf("counts = %+v at clock %d, want %+v at 17", view.Counts, view.Clock, want)
	}
	if len(view.Core) != 1 || view.Core[0].ID != core {
		t.Errorf("core list = %d memories, want the one core memory", len(view.Core))
	}
	if len(view.Recent) != 8 || view.Recent[0].ID != recent {
		t.Fatalf("recent list = %d memories, want 8 with the newest first", len(view.Recent))
	}
	for _, m := range view.Recent {
		if m.ID == core {
			t.Error("the core memory is listed twice")
		}
	}
	if got := f.get(old).Tier(view.Clock); got != store.TierFaded {
		t.Errorf("the old memory is %s, want faded", got)
	}

	// Being shown at the start of a session is not coming to mind.
	f.sync()
	for _, shown := range append(view.Recent, view.Core...) {
		if m := f.get(shown.ID); m.RecallCount != 0 || m.TouchedOrd != m.Ord {
			t.Errorf("get_context touched %q: count %d, touched at %d", m.Gist, m.RecallCount, m.TouchedOrd)
		}
	}
	if _, events, _ := f.st.Counts(ctx); events != 2+17 {
		t.Errorf("events = %d, want the 2 sessions and the 17 memories", events)
	}

	// Sixty memories later the old one has left the list; the core one has not.
	f.fill(60)
	view = f.begin("model-a", "desktop")
	if want := (store.TierCounts{Core: 1, Active: 13, Faded: 17, Archived: 46}); view.Counts != want {
		t.Errorf("much later: counts %+v, want %+v", view.Counts, want)
	}
	if len(view.Core) != 1 || view.Core[0].ID != core || len(view.Recent) != 8 {
		t.Errorf("much later: %d core, %d recent", len(view.Core), len(view.Recent))
	}
	if got := f.tier(old); got != store.TierArchived {
		t.Errorf("much later the old memory is %s, want archived", got)
	}
}

// What comes to mind is written down a moment later, by a background worker.
// Memories written in that moment must not count as having lain between.
func TestComingToMindIsDatedWhenItHappens(t *testing.T) {
	f := start(t, tempDB(t), nil)
	read := f.remember("读过全文的事", "正文甲")
	listed := f.remember("只被搜到的事", "正文乙")
	f.fill(5)
	f.expand(read) // 6 memories after it was written
	if rs := f.recall("搜到"); len(rs) != 1 || rs[0].ID != listed {
		t.Fatalf("setup recall = %v", ids(rs))
	}
	f.fill(10) // before the worker gets to it, or after: it must not matter
	f.sync()

	want := 10 * (1 + 2*(1-math.Exp(-0.6)))
	if m := f.get(read); m.ReadOrd != 7 || m.TouchedOrd != 7 || math.Abs(m.Strength-want) > 1e-6 {
		t.Errorf("read at clock 7: read %d, touched %d, strength %.4f; want 7, 7, %.4f", m.ReadOrd, m.TouchedOrd, m.Strength, want)
	}
	if m := f.get(listed); m.TouchedOrd != 7 || m.Strength != 10 {
		t.Errorf("listed at clock 7: touched %d, strength %v; want 7, 10", m.TouchedOrd, m.Strength)
	}
}
