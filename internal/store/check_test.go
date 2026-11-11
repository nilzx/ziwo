package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func checked(t *testing.T, s *Store) Report {
	t.Helper()
	r, err := s.Check(context.Background())
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	return r
}

// found returns the finding with the given code, or fails.
func found(t *testing.T, r Report, level, code string) Finding {
	t.Helper()
	for _, f := range r.Findings {
		if f.Code == code {
			if f.Level != level {
				t.Errorf("[%s] is a %s, want a %s", code, f.Level, level)
			}
			return f
		}
	}
	t.Errorf("the check did not find [%s]:\n%s", code, r)
	return Finding{}
}

func TestCheckOfAMemoryInGoodOrder(t *testing.T) {
	s := newStore(t)
	kept, erased := life(t, s)
	r := checked(t, s)
	if r.Count(LevelProblem) != 0 || r.Count(LevelWarning) != 0 {
		t.Errorf("a memory in good order has findings:\n%s", r)
	}
	out := r.String()
	for _, want := range []string{"format 3", "9 memories written", "1 erased", "1 rounds of reflection",
		"4 standing (1 core, 3 active, 0 faded, 0 archived), 4 set aside or part of another; the clock reads 4",
		"1 statements stand", "1 in force", "problems: none", "warnings: none"} {
		if !strings.Contains(out, want) {
			t.Errorf("the report lacks %q:\n%s", want, out)
		}
	}
	// It names memories by id and never says what one says.
	for _, text := range []string{"记忆系统", "keptmark4v", "问清", "天气", "用户", "说话直接", "住址"} {
		if strings.Contains(out, text) {
			t.Errorf("the report quotes a memory: %q\n%s", text, out)
		}
	}
	_, _ = kept, erased

	// A file that has never been served has no tables to check yet.
	path := t.TempDir() + "/log-only.ziwo"
	lo, err := Open(context.Background(), path, Options{Create: true, LogOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer lo.Close()
	found(t, checked(t, lo), LevelNote, "not-built")
}

func TestCheckFindsADamagedRecord(t *testing.T) {
	s := newStore(t)
	sess := session(t, s, t0, "", "cli")
	lost := remember(t, s, t0, sess.ID, "会丢正文的记忆", "正文一")
	altered := remember(t, s, t0, sess.ID, "正文被改的记忆", "正文二")
	gone := remember(t, s, t0, sess.ID, "被删除的记忆", "正文三")
	stays := remember(t, s, t0, sess.ID, "删了但正文还在的记忆", "正文四")
	if _, err := s.Erase(context.Background(), t0, sess.ID, gone, ""); err != nil {
		t.Fatal(err)
	}
	// Do to the file what the store itself never does.
	for _, stmt := range []string{
		`DELETE FROM contents WHERE id = '` + lost + `'`,
		`DROP TRIGGER contents_no_update`,
		`UPDATE contents SET data = replace(data, '正文二', '别的话') WHERE id = '` + altered + `'`,
		`INSERT INTO contents(id, data) VALUES('m_nobody', '{"gist":"x"}')`,
		`DROP TRIGGER events_no_update`,
		`UPDATE events SET kind = 'erase', payload = '{"session":"` + sess.ID + `","id":"` + stays + `"}' WHERE kind = 'erase'`,
		`INSERT INTO events(at, kind, payload) VALUES(1, 'remember', '{"id":"m_stray","session":"s_nobody","moment":"other","source":"lived","importance":0.5,"hash":""}')`,
		`INSERT INTO links(src, dst) VALUES('` + lost + `', 'm_missing')`,
		`UPDATE memories SET ord = ord + 7 WHERE id = '` + stays + `'`,
	} {
		if _, err := s.w.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	r := checked(t, s)
	if f := found(t, r, LevelProblem, "content-lost"); len(f.IDs) != 3 || !has(f.IDs, lost) || !has(f.IDs, gone) {
		t.Errorf("content-lost names %v", f.IDs)
	}
	if f := found(t, r, LevelProblem, "content-altered"); len(f.IDs) != 1 || f.IDs[0] != altered {
		t.Errorf("content-altered names %v", f.IDs)
	}
	if f := found(t, r, LevelProblem, "erase-incomplete"); len(f.IDs) != 1 || f.IDs[0] != stays {
		t.Errorf("erase-incomplete names %v", f.IDs)
	}
	found(t, r, LevelProblem, "content-orphaned")
	found(t, r, LevelProblem, "session-unknown")
	found(t, r, LevelProblem, "tables-stale")
	found(t, r, LevelProblem, "clock-off")
	if f := found(t, r, LevelProblem, "link-broken"); !has(f.IDs, lost) {
		t.Errorf("link-broken names %v", f.IDs)
	}
}

func TestCheckFlagsUseThatWillNotServe(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	busy := session(t, s, t0, "", "cli")
	quiet := session(t, s, t0, "", "cli")
	var code, twinA, twinB string
	for i := 0; i < 60; i++ {
		in := RememberInput{SessionID: busy.ID, Gist: fmt.Sprintf("第 %d 件事", i), Body: fmt.Sprintf("正文 %d", i)}
		switch {
		case i < 25:
			in.Importance = 0.95 // most things marked as never to fade
		case i < 45:
			in.Feeling, in.Intensity = "震动", 0.95 // and most things felt to the utmost
		case i == 45:
			in.Body = "改法如下：\n```go\nfunc main() {}\n```"
		case i == 46, i == 47:
			in.Gist = "一模一样的梗概"
		}
		id := rememberWith(t, s, in)
		switch i {
		case 45:
			code = id
		case 46:
			twinA = id
		case 47:
			twinB = id
		}
	}
	a := remember(t, s, t0, quiet.ID, "另一段对话里的事", "正文")
	long := rememberWith(t, s, RememberInput{SessionID: quiet.ID, Gist: "一段很长的记录", Body: strings.Repeat("字", checkLongBody+1)})
	b := rememberWith(t, s, RememberInput{SessionID: busy.ID, Gist: "在场的经历一", Body: "正文"})
	c := rememberWith(t, s, RememberInput{SessionID: busy.ID, Gist: "在场的经历二", Body: "正文"})
	i1, i2 := ent(KindImpression, "印象一", a), ent(KindImpression, "印象二", b)
	i1.About, i2.About = "Alex", "alex "
	ids := reflectOn(t, s, quiet.ID, []Entry{{Kind: KindSelf, Gist: "一句自述", Importance: 0.5, From: []string{a, b, c}}, i1, i2})
	amend(t, s, quiet.ID, AmendRetract, b, 0)

	r := checked(t, s)
	if r.Count(LevelProblem) != 0 {
		t.Errorf("nothing is damaged here, yet:\n%s", r)
	}
	if f := found(t, r, LevelWarning, "many-writes"); len(f.IDs) != 1 || !strings.HasPrefix(f.IDs[0], busy.ID+" (") {
		t.Errorf("many-writes names %v, want the one busy conversation with its count", f.IDs)
	}
	found(t, r, LevelWarning, "core-inflated")
	found(t, r, LevelWarning, "feeling-inflated")
	if f := found(t, r, LevelWarning, "looks-like-project-notes"); len(f.IDs) != 2 || !has(f.IDs, code) || !has(f.IDs, long) {
		t.Errorf("looks-like-project-notes names %v", f.IDs)
	}
	if f := found(t, r, LevelWarning, "same-gist"); len(f.IDs) != 2 || !has(f.IDs, twinA) || !has(f.IDs, twinB) {
		t.Errorf("same-gist names %v", f.IDs)
	}
	if f := found(t, r, LevelWarning, "self-unsupported"); len(f.IDs) != 1 || f.IDs[0] != ids[0] {
		t.Errorf("self-unsupported names %v", f.IDs)
	}
	found(t, r, LevelWarning, "backlog")
	found(t, r, LevelNote, "name-variants")
	found(t, r, LevelNote, "never-came-to-mind")
	if out := r.String(); strings.Contains(out, "一模一样") || strings.Contains(out, "Alex") || strings.Contains(out, "func main") {
		t.Errorf("the report quotes a memory:\n%s", out)
	}
	_ = ctx
}
