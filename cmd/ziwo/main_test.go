package main

import (
	"bytes"
	"context"
	"database/sql"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"github.com/nilzx/ziwo/internal/host"
	"github.com/nilzx/ziwo/internal/store"
)

var tokenRE = regexp.MustCompile(`ziwo_[A-Za-z0-9_-]{43}`)

// ziwo runs one command line and returns what it printed.
func ziwo(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(args, &out)
	return out.String(), err
}

func must(t *testing.T, args ...string) string {
	t.Helper()
	out, err := ziwo(t, args...)
	if err != nil {
		t.Fatalf("ziwo %s: %v", strings.Join(args, " "), err)
	}
	return out
}

func TestManagingMemories(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")

	out := must(t, "new", "claude", "-dir", dir)
	first := tokenRE.FindString(out)
	if first == "" || !strings.Contains(out, "/claude/mcp") || !strings.Contains(out, filepath.Join(dir, "claude.ziwo")) {
		t.Fatalf("new:\n%s", out)
	}
	// Flags may come before the name as well.
	out = must(t, "new", "-dir", dir, "gpt")
	if other := tokenRE.FindString(out); other == "" || other == first {
		t.Fatalf("second memory's token %q, first was %q", other, first)
	}

	out = must(t, "list", "-dir", dir)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "NAME") || !strings.HasPrefix(lines[1], "claude") || !strings.HasPrefix(lines[2], "gpt") {
		t.Errorf("list:\n%s", out)
	}
	for _, line := range lines[1:] {
		if f := strings.Fields(line); len(f) != 5 || f[1] != "0" || f[2] != "0" || f[3] != "never" || f[4] != "set" {
			t.Errorf("list line %q, want an empty memory with a token", line)
		}
	}
	if strings.Contains(out, "ziwo_") {
		t.Errorf("list printed a token:\n%s", out)
	}

	out = must(t, "token", "claude", "-dir", dir)
	if second := tokenRE.FindString(out); second == "" || second == first || !strings.Contains(out, "old token no longer works") {
		t.Errorf("token:\n%s", out)
	}
	if out = must(t, "rebuild", "-dir", dir, "claude", "-strength", "50"); out != "rebuilt 0 memories from 0 events\n" {
		t.Errorf("rebuild: %q", out)
	}

	// The data directory can come from the environment.
	t.Setenv("ZIWO_DIR", dir)
	if out = must(t, "list"); !strings.Contains(out, "claude") || !strings.Contains(out, "gpt") {
		t.Errorf("list with ZIWO_DIR:\n%s", out)
	}
	empty := t.TempDir()
	if out = must(t, "list", "-dir", empty); !strings.Contains(out, "no memories in "+empty) || !strings.Contains(out, "ziwo new <name>") {
		t.Errorf("list of an empty directory: %q", out)
	}
}

func TestMistakesOnTheCommandLine(t *testing.T) {
	dir := t.TempDir()
	must(t, "new", "claude", "-dir", dir)

	for name, tc := range map[string]struct {
		args []string
		want string // part of the error
	}{
		"unknown command":          {[]string{"remember"}, `unknown command "remember"`},
		"new without a name":       {[]string{"new", "-dir", dir}, "give the memory's name"},
		"new with a bad name":      {[]string{"new", "Claude", "-dir", dir}, "invalid memory name"},
		"new with a path":          {[]string{"new", "../claude", "-dir", dir}, "invalid memory name"},
		"new twice":                {[]string{"new", "claude", "-dir", dir}, "already exists"},
		"new with two names":       {[]string{"new", "a", "b", "-dir", dir}, `unexpected argument "b"`},
		"token for nobody":         {[]string{"token", "nobody", "-dir", dir}, "no such memory"},
		"rebuild nobody":           {[]string{"rebuild", "nobody", "-dir", dir}, "no such memory"},
		"rebuild with bad params":  {[]string{"rebuild", "claude", "-dir", dir, "-strength", "0"}, "base strength must be positive"},
		"list with an argument":    {[]string{"list", "claude", "-dir", dir}, `unexpected argument "claude"`},
		"list of a missing dir":    {[]string{"list", "-dir", filepath.Join(dir, "missing")}, "no such file or directory"},
		"serve with an argument":   {[]string{"serve", "-dir", dir, "claude"}, `unexpected argument "claude"`},
		"serve of a missing dir":   {[]string{"serve", "-dir", filepath.Join(dir, "missing"), "-addr", "127.0.0.1:0"}, "no such file or directory"},
		"open to the network":      {[]string{"serve", "-dir", dir, "-no-auth", "-addr", "0.0.0.0:0"}, "-no-auth is only allowed"},
		"open on every interface":  {[]string{"-no-auth", "-addr", ":8377", "-dir", dir}, "-no-auth is only allowed"},
		"embedding without model":  {[]string{"serve", "-dir", dir, "-embed-url", "http://127.0.0.1:1/v1/embeddings"}, "-embed-model is required"},
		"thresholds out of order":  {[]string{"serve", "-dir", dir, "-fade-below", "0.01"}, "archive threshold < fade threshold"},
		"strength that is no size": {[]string{"serve", "-dir", dir, "-strength", "-3"}, "base strength must be positive"},
	} {
		out, err := ziwo(t, tc.args...)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want one saying %q", name, err, tc.want)
		}
		if tokenRE.MatchString(out) {
			t.Errorf("%s: a token was printed although the command failed:\n%s", name, out)
		}
	}
	// None of that created or removed anything.
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 1 || entries[0].Name() != "claude.ziwo" {
		t.Errorf("the data directory after the mistakes: %v, %v", entries, err)
	}
}

func TestHelp(t *testing.T) {
	for _, args := range [][]string{{"help"}, {"-h"}, {"--help"}} {
		out := must(t, args...)
		for _, want := range []string{"ziwo new <name>", "ziwo token <name>", "ziwo list", "ziwo rebuild <name>", "/<name>/mcp"} {
			if !strings.Contains(out, want) {
				t.Errorf("ziwo %s lacks %q:\n%s", args[0], want, out)
			}
		}
	}
	// Asking a command for its flags is not a failure.
	if _, err := ziwo(t, "new", "-h"); err != flag.ErrHelp {
		t.Errorf("ziwo new -h: err = %v, want flag.ErrHelp", err)
	}
}

func TestLoopback(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:8377": true, "localhost:8377": true, "[::1]:8377": true, "127.0.0.2:1": true,
		":8377": false, "0.0.0.0:8377": false, "192.168.1.5:8377": false, "example.com:80": false,
		"[::]:8377": false, "8377": false, "": false,
	} {
		if got := loopback(addr); got != want {
			t.Errorf("loopback(%q) = %v, want %v", addr, got, want)
		}
	}
}

// fillMemory writes two memories into the named memory, as a server would.
func fillMemory(t *testing.T, dir, name string) {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, host.Path(dir, name), store.Options{Params: store.DefaultParams()})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sess, _, err := st.StartSession(ctx, time.Now(), "model-a", "cli")
	if err != nil {
		t.Fatal(err)
	}
	for _, gist := range []string{"用户给我看了他的猫 plainmark7q", "用户第一次把项目交给我"} {
		if _, _, err := st.Remember(ctx, time.Now(), store.RememberInput{SessionID: sess.ID, Moment: "other", Source: "lived",
			Importance: 0.5, Gist: gist, Body: "正文"}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBackingUpAndBringingBack(t *testing.T) {
	dir, elsewhere := t.TempDir(), filepath.Join(t.TempDir(), "restored")
	token := tokenRE.FindString(must(t, "new", "claude", "-dir", dir))
	fillMemory(t, dir, "claude")
	file := filepath.Join(t.TempDir(), "claude.ziwo-export")

	// An export is never written in the clear, so it needs a passphrase.
	t.Setenv("ZIWO_EXPORT_KEY", "")
	if _, err := ziwo(t, "export", "claude", "-dir", dir, "-o", file); err == nil || !strings.Contains(err.Error(), "ZIWO_EXPORT_KEY") {
		t.Fatalf("export without a passphrase: %v", err)
	}
	t.Setenv("ZIWO_EXPORT_KEY", "short")
	if _, err := ziwo(t, "export", "claude", "-dir", dir, "-o", file); err == nil || !strings.Contains(err.Error(), "at least") {
		t.Fatalf("export with a five-letter passphrase: %v", err)
	}
	t.Setenv("ZIWO_EXPORT_KEY", "a passphrase long enough")
	if out := must(t, "export", "claude", "-o", file, "-dir", dir); !strings.Contains(out, "exported 3 events") {
		t.Errorf("export: %s", out)
	}
	sealed, err := os.ReadFile(file)
	if err != nil || bytes.Contains(sealed, []byte("plainmark7q")) || bytes.Contains(sealed, []byte(token)) {
		t.Fatalf("the export file: %v; it must not hold the text or the token in the clear", err)
	}
	if info, _ := os.Stat(file); info.Mode().Perm()&0o077 != 0 {
		t.Errorf("the export file is readable by others: %v", info.Mode().Perm())
	}
	if _, err := ziwo(t, "export", "claude", "-dir", dir, "-o", file); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("export over an existing file: %v", err)
	}

	t.Setenv("ZIWO_EXPORT_KEY", "not the passphrase at all")
	if _, err := ziwo(t, "import", "copy", file, "-dir", elsewhere); err == nil || !strings.Contains(err.Error(), "wrong passphrase") {
		t.Errorf("import with the wrong passphrase: %v", err)
	}
	t.Setenv("ZIWO_EXPORT_KEY", "a passphrase long enough")
	out := must(t, "import", "-dir", elsewhere, "copy", file)
	for _, want := range []string{"brought back 2 memories from 3 events", "/copy/mcp", "answers to the token it had"} {
		if !strings.Contains(out, want) {
			t.Errorf("import lacks %q:\n%s", want, out)
		}
	}
	// The restore itself is one more event.
	if out := must(t, "list", "-dir", elsewhere); !regexp.MustCompile(`copy\s+2\s+4\s`).MatchString(out) {
		t.Errorf("list of the restored memory:\n%s", out)
	}
	for name, args := range map[string][]string{
		"over an existing memory": {"import", "copy", file, "-dir", elsewhere},
		"under a bad name":        {"import", "Bad Name", file, "-dir", elsewhere},
		"without a file":          {"import", "other", "-dir", elsewhere},
		"from a file that is not": {"import", "other", filepath.Join(dir, "claude.ziwo"), "-dir", elsewhere},
	} {
		if out, err := ziwo(t, args...); err == nil {
			t.Errorf("import %s was accepted: %s", name, out)
		}
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 1 {
		t.Errorf("refused imports left files behind: %v", entries)
	}
}

func TestCheckFromTheCommandLine(t *testing.T) {
	dir := t.TempDir()
	must(t, "new", "claude", "-dir", dir)
	if out := must(t, "check", "claude", "-dir", dir); !strings.Contains(out, "not been built yet") {
		t.Errorf("check of a memory that was never served:\n%s", out)
	}
	fillMemory(t, dir, "claude")
	out := must(t, "check", "claude", "-dir", dir)
	if !strings.Contains(out, "2 memories written") || !strings.Contains(out, "problems: none") || strings.Contains(out, "猫") || strings.Contains(out, "plainmark7q") {
		t.Errorf("check of a memory in good order must give figures and no text:\n%s", out)
	}

	// Damage it the way no command does, and the check fails.
	raw, err := sql.Open("sqlite3", "file:"+host.Path(dir, "claude"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`DELETE FROM contents WHERE id = (SELECT min(id) FROM contents)`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	out, err = ziwo(t, "check", "claude", "-dir", dir)
	if err == nil || !strings.Contains(err.Error(), "1 problem(s)") || !strings.Contains(out, "[content-lost]") {
		t.Errorf("check of a damaged memory: err = %v\n%s", err, out)
	}
	if _, err := ziwo(t, "check", "nobody", "-dir", dir); err == nil {
		t.Error("check of a memory that does not exist succeeded")
	}
}
