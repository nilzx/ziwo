package store

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// life writes a memory with a little of everything in it and returns the ids
// of a kept and an erased memory.
func life(t *testing.T, s *Store) (kept, erased string) {
	t.Helper()
	ctx := context.Background()
	a := session(t, s, t0, "model-a", "cli")
	b := session(t, s, t0.Add(time.Hour), "model-b", "desktop")
	f1 := remember(t, s, t0, a.ID, "用户让我做一个记忆系统", "我先问清了它要记什么 keptmark4v。")
	f2 := remember(t, s, t0, a.ID, "用户纠正了我的理解", "他说要记的是经历。")
	f3 := remember(t, s, t0, b.ID, "另一次我也先问清了需求", "用户说这样省了返工。")
	erased = remember(t, s, t0, b.ID, "用户告诉我一件私事", "住址是 qx4private7k 路。")
	rememberWith(t, s, RememberInput{SessionID: a.ID, Source: SourceReconstructed, Gist: "半年前的一个项目", Body: "从记录里整理的。", Happened: t0.AddDate(0, -6, 0)})
	fixed, err := s.Correct(ctx, t0, f2, RememberInput{SessionID: a.ID, Moment: "other", Source: "lived", Importance: 0.5, Gist: "用户纠正了我对记忆系统的理解", Body: "他说要记的是经历。"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Erase(ctx, t0, b.ID, erased, "the user asked"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPreference(ctx, t0, a.ID, "不用记天气之类的闲聊", 30); err != nil {
		t.Fatal(err)
	}
	imp := ent(KindImpression, "说话直接", fixed)
	imp.About = "用户"
	reflectOn(t, s, a.ID, []Entry{ent(KindEpisode, "把方向定了下来", f1, fixed), imp,
		{Kind: KindSelf, Gist: "我动手前会先问清楚", Context: "做设计的时候", Importance: 0.5, From: []string{f1, fixed, f3}}}, f3)
	amend(t, s, a.ID, AmendPin, f3, 0)
	listed(t, s, f3)
	read(t, s, f3)
	if err := s.SetTokenHash(ctx, "tokenhash"); err != nil {
		t.Fatal(err)
	}
	return f1, erased
}

func TestAnExportBringsTheWholeMemoryBack(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := open(t, filepath.Join(dir, "a.ziwo"))
	kept, erased := life(t, s)
	var file bytes.Buffer
	events, err := s.Export(ctx, &file, t0.Add(24*time.Hour))
	if err != nil || events == 0 {
		t.Fatalf("export: %d events, %v", events, err)
	}
	if bytes.Contains(file.Bytes(), []byte("qx4private7k")) || !bytes.Contains(file.Bytes(), []byte("keptmark4v")) {
		t.Error("the export should hold what was kept and nothing of what was erased")
	}

	path := filepath.Join(dir, "b.ziwo")
	st, err := Import(ctx, path, bytes.NewReader(file.Bytes()), t0.Add(72*time.Hour))
	if err != nil || st.Events != events || st.Memories != 9 || !st.HasToken || !st.ExportedAt.Equal(t0.Add(24*time.Hour)) {
		t.Fatalf("import: %+v, %v", st, err)
	}
	back := open(t, path)
	// Everything derived from the log is the same in both.
	if want, got := dump(t, s), dump(t, back); want != got {
		t.Errorf("the restored memory differs\noriginal:\n%s\nrestored:\n%s", want, got)
	}
	if m := get(t, back, kept); !strings.Contains(m.Body, "keptmark4v") || get(t, back, erased).State != StateErased {
		t.Errorf("restored memories: %+v", m)
	}
	if hash, ok, _ := back.TokenHash(ctx); !ok || hash != "tokenhash" {
		t.Errorf("token hash after the restore: %q, %v", hash, ok)
	}
	// The restored memory knows that it was brought back; the original does not.
	note, ok, err := back.LastRestore(ctx)
	if err != nil || !ok || !note.At.Equal(t0.Add(72*time.Hour)) || !note.ExportedAt.Equal(t0.Add(24*time.Hour)) {
		t.Errorf("restore note: %+v, %v, %v", note, ok, err)
	}
	if _, ok, _ := s.LastRestore(ctx); ok {
		t.Error("the original says it was restored")
	}
	_, origEvents, _ := s.Counts(ctx)
	if _, n, _ := back.Counts(ctx); n != origEvents+1 {
		t.Errorf("events: %d restored, %d original; want one more, the restore itself", n, origEvents)
	}
	a, _ := metaValue(t, filepath.Join(dir, "a.ziwo"), metaInstance)
	b, _ := metaValue(t, path, metaInstance)
	if a == "" || b == "" || a == b {
		t.Errorf("instances: %q and %q; want two different names", a, b)
	}
	// It goes on living: it can be written to, and exported again.
	sess := session(t, back, t0.Add(96*time.Hour), "model-c", "cli")
	remember(t, back, t0.Add(96*time.Hour), sess.ID, "还原之后的第一件事", "正文")
	replays(t, back)
	var second bytes.Buffer
	if _, err := back.Export(ctx, &second, t0.Add(100*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if st, err := Import(ctx, filepath.Join(dir, "c.ziwo"), &second, t0.Add(101*time.Hour)); err != nil || st.Memories != 10 {
		t.Errorf("an export of the restored memory: %+v, %v", st, err)
	}
	if report, err := back.Check(ctx); err != nil || report.Count(LevelProblem) != 0 {
		t.Errorf("check of the restored memory: %v\n%s", err, report)
	}
}

func TestADamagedExportIsNotBroughtBack(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := open(t, filepath.Join(dir, "a.ziwo"))
	life(t, s)
	var file bytes.Buffer
	if _, err := s.Export(ctx, &file, t0); err != nil {
		t.Fatal(err)
	}
	good := file.String()
	lines := strings.SplitAfter(good, "\n")

	for name, bad := range map[string]string{
		"cut short":                  strings.Join(lines[:len(lines)-3], ""),
		"without its footer":         strings.Join(lines[:len(lines)-2], ""),
		"an event changed":           strings.Replace(good, `"importance":0.5`, `"importance":0.9`, 1),
		"what a memory says changed": strings.Replace(good, "keptmark4v", "keptmark4w", 1),
		"an event removed":           strings.Join(append(append([]string{}, lines[:3]...), lines[4:]...), ""),
		"two events swapped":         strings.Join(append([]string{lines[0], lines[2], lines[1]}, lines[3:]...), ""),
		"its last events dropped":    strings.Join(append(append([]string{}, lines[:len(lines)-5]...), lines[len(lines)-2:]...), ""),
		"not an export":              "hello\n",
		"empty":                      "",
		"another kind of export":     strings.Replace(good, `"ziwo_export":1`, `"ziwo_export":9`, 1),
	} {
		path := filepath.Join(dir, "bad.ziwo")
		if _, err := Import(ctx, path, strings.NewReader(bad), t0); !errors.Is(err, ErrBadExport) {
			t.Errorf("%s: err = %v, want it refused as a bad export", name, err)
		}
		if left, _ := filepath.Glob(path + "*"); len(left) != 0 {
			t.Errorf("%s: a refused import left %v behind", name, left)
			for _, f := range left {
				os.Remove(f)
			}
		}
	}
	// A change is pinned to the event where it was made.
	_, err := Import(ctx, filepath.Join(dir, "bad.ziwo"), strings.NewReader(strings.Replace(good, "keptmark4v", "keptmark4w", 1)), t0)
	if err == nil || !strings.Contains(err.Error(), "changed or damaged at event 3") {
		t.Errorf("a changed memory: %v, want the event named", err)
	}
	if _, err := Import(ctx, filepath.Join(dir, "new.ziwo"), strings.NewReader(strings.Replace(good, `"log_format":3`, `"log_format":99`, 1)), t0); !errors.Is(err, ErrNewerFormat) {
		t.Errorf("an export from a newer build: %v", err)
	}
	if _, err := Import(ctx, filepath.Join(dir, "a.ziwo"), strings.NewReader(good), t0); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("importing over an existing memory: %v", err)
	}
	if m, _, _ := s.Counts(ctx); m != 9 {
		t.Errorf("the existing memory was touched: %d memories", m)
	}
}
