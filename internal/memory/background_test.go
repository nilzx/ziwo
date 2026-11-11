package memory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nilzx/ziwo/internal/store"
)

// cannedReflector stands in for a chat model: it answers with what the test
// lined up and keeps what it was shown.
type cannedReflector struct {
	mu      sync.Mutex
	replies []string
	fail    error
	shown   []string
}

func (r *cannedReflector) Model() string { return "background-model" }

func (r *cannedReflector) Complete(ctx context.Context, system, user string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.shown = append(r.shown, system+"\n---\n"+user)
	if r.fail != nil {
		return "", r.fail
	}
	if len(r.replies) == 0 {
		return "", errors.New("the test lined up no reply")
	}
	reply := r.replies[0]
	r.replies = r.replies[1:]
	return reply, nil
}

func TestReflectionInTheBackground(t *testing.T) {
	model := &cannedReflector{}
	f := startWith(t, tempDB(t), nil, Config{Reflector: model, ReflectMin: 3, ReflectEvery: time.Hour})
	ctx := context.Background()
	round := func() (int, error) { return f.svc.backgroundRound(ctx) }

	a := f.remember("用户让我做一个记忆系统", "我先问清了它要记什么。")
	b := f.remember("用户纠正了我的理解", "他说要记的是经历。")
	f.clock.Advance(time.Hour)
	if n, err := round(); n != 0 || err != nil || len(model.shown) != 0 {
		t.Fatalf("with two moments waiting: wrote %d, err %v, asked the model %d times; want it to wait for three", n, err, len(model.shown))
	}
	c := f.remember("用户问了天气", "聊了几句。")
	if n, err := round(); n != 0 || err != nil || len(model.shown) != 0 {
		t.Fatalf("while a conversation is under way: wrote %d, err %v, asked %d times; want it to stay out", n, err, len(model.shown))
	}

	// Half an hour of quiet. The model answers with more than it may write:
	// a statement about the self, and things resting on memories it was not shown.
	f.clock.Advance(31 * time.Minute)
	model.replies = []string{fmt.Sprintf("Here is what I make of it:\n```json\n"+`{"entries": [
		{"kind": "episode", "gist": "我和用户把记忆系统的方向定了下来", "body": "先问清，再被纠正。", "from": [%q, %q]},
		{"kind": "self", "gist": "我很谨慎", "from": [%q, %q, %q]},
		{"kind": "lesson", "gist": "一条经验", "body": "正文", "from": ["m_notshown"]}],
		"pass": [%q, "m_notshown"]}`+"\n```", a, b, a, b, c, c)}
	n, err := round()
	if n != 1 || err != nil {
		t.Fatalf("the round wrote %d, err %v; want the episode alone", n, err)
	}
	if shown := model.shown[0]; !strings.Contains(shown, a) || !strings.Contains(shown, "我先问清了它要记什么。") || !strings.Contains(shown, "Reply with one JSON object") {
		t.Errorf("what the model was shown:\n%s", shown)
	}
	recent, _ := f.st.Recent(ctx, f.lived(), 10)
	if len(recent) != 2 || recent[0].Kind != store.KindEpisode || recent[0].Model != "background-model" || recent[0].Client != BackgroundClient {
		t.Fatalf("after the round: %d standing memories, newest %+v", len(recent), recent[0])
	}
	if f.get(a).State != store.StateAbsorbed || f.get(c).Pending || f.get(c).State != "" {
		t.Errorf("fragments after the round: %+v / %+v", f.get(a), f.get(c))
	}
	if selves, _ := f.st.Selves(ctx); len(selves) != 0 {
		t.Errorf("a background round wrote a statement about the self: %+v", selves)
	}
	if n, err := round(); n != 0 || err != nil || len(model.shown) != 1 {
		t.Errorf("with nothing left waiting: wrote %d, err %v, asked %d times", n, err, len(model.shown))
	}

	// A model that does not answer as asked writes nothing, and does not
	// keep a conversation from reflecting.
	d := f.remember("又一件事", "正文一")
	f.remember("再一件事", "正文二")
	f.remember("第三件事", "正文三")
	for _, tc := range []struct {
		name    string
		fail    error
		reply   string
		wantErr bool
	}{
		{"prose instead of JSON", nil, "These are lovely memories.", true},
		{"JSON that does not fit", nil, `{"entries": "none"}`, true},
		{"the endpoint is down", errors.New("connection refused"), "", true},
		{"an entry that cannot be written", nil, fmt.Sprintf(`{"entries":[{"kind":"impression","gist":"没有说是谁","from":[%q]}]}`, d), true},
		{"nothing that rests on what it was shown", nil, fmt.Sprintf(`{"entries":[{"kind":"lesson","gist":"g","body":"b","from":[%q]}],"pass":[]}`, a), false},
	} {
		f.clock.Advance(31 * time.Minute)
		model.fail, model.replies = tc.fail, []string{tc.reply}
		before, _, _ := f.st.Counts(ctx)
		if n, err := round(); n != 0 || (err != nil) != tc.wantErr {
			t.Errorf("%s: wrote %d, err %v; want nothing written, error %v", tc.name, n, err, tc.wantErr)
		}
		if after, _, _ := f.st.Counts(ctx); after != before {
			t.Errorf("%s: %d memories were written", tc.name, after-before)
		}
		view, err := f.svc.BeginReflect(ctx, f.sess(), 0)
		if err != nil || view.Batch == "" {
			t.Fatalf("%s: a conversation cannot reflect afterwards: %v", tc.name, err)
		}
		if err := f.st.AbandonReflect(ctx, f.sess(), view.Batch); err != nil {
			t.Fatal(err)
		}
	}
}
