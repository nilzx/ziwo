package host

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nilzx/ziwo/internal/store"
)

var (
	memoryID  = regexp.MustCompile(`m_[a-z2-9]{8}`)
	sessionID = regexp.MustCompile(`s_[a-z2-9]{8}`)
)

// running is a host serving a data directory.
type running struct {
	t   *testing.T
	dir string
	h   *Host
	url string
}

func run(t *testing.T, dir string, cfg Config) *running {
	t.Helper()
	cfg.Dir = dir
	if cfg.Params == (store.Params{}) {
		cfg.Params = store.DefaultParams()
	}
	h := New(cfg)
	ts := httptest.NewServer(h.Handler())
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
		if err := h.Close(); err != nil {
			t.Errorf("close host: %v", err)
		}
	})
	return &running{t: t, dir: dir, h: h, url: ts.URL}
}

func create(t *testing.T, dir, name string) (token string) {
	t.Helper()
	token, err := Create(context.Background(), dir, name)
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return token
}

type withToken struct{ token string }

func (w withToken) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if w.token != "" {
		r.Header.Set("Authorization", "Bearer "+w.token)
	}
	return http.DefaultTransport.RoundTrip(r)
}

// client is one MCP client connected to one memory.
type client struct {
	t    *testing.T
	sess *mcp.ClientSession
}

func (r *running) dial(name, token string) (*mcp.ClientSession, error) {
	c := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "1.0"}, nil)
	return c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:             r.url + "/" + name + "/mcp",
		HTTPClient:           &http.Client{Transport: withToken{token}, Timeout: 10 * time.Second},
		DisableStandaloneSSE: true,
	}, nil)
}

func (r *running) connect(name, token string) *client {
	r.t.Helper()
	sess, err := r.dial(name, token)
	if err != nil {
		r.t.Fatalf("connect to %s: %v", name, err)
	}
	r.t.Cleanup(func() { sess.Close() })
	return &client{t: r.t, sess: sess}
}

func (c *client) call(tool string, args map[string]any) (string, error) {
	res, err := c.sess.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, part := range res.Content {
		if tc, ok := part.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	if res.IsError {
		return "", errors.New(b.String())
	}
	return b.String(), nil
}

func (c *client) ok(tool string, args map[string]any) string {
	c.t.Helper()
	out, err := c.call(tool, args)
	if err != nil {
		c.t.Fatalf("%s: %v", tool, err)
	}
	return out
}

func (c *client) remember(gist, body string) string {
	c.t.Helper()
	session := sessionID.FindString(c.ok("get_context", nil))
	return memoryID.FindString(c.ok("remember", map[string]any{"session_id": session, "gist": gist, "body": body}))
}

const initialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}`

// post sends an initialize request and returns the status and the body.
func (r *running) post(path, authorization string) (int, string) {
	r.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, r.url+path, strings.NewReader(initialize))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, string(body)
}

func TestEachMemoryHasItsOwnAddressAndToken(t *testing.T) {
	dir := t.TempDir()
	claudeToken := create(t, dir, "claude")
	gptToken := create(t, dir, "gpt")
	if claudeToken == gptToken || !strings.HasPrefix(claudeToken, "ziwo_") || len(claudeToken) < 40 {
		t.Fatalf("tokens: %q and %q", claudeToken, gptToken)
	}
	srv := run(t, dir, Config{})

	claude := srv.connect("claude", claudeToken)
	gpt := srv.connect("gpt", gptToken)
	mine := claude.remember("用户第一次把部署交给我", "上线很顺利。")
	theirs := gpt.remember("The user asked me to review a contract", "It took three rounds.")

	// Each sees its own life and nothing of the other's.
	out := claude.ok("get_context", nil)
	if !strings.Contains(out, "memories: 1 ") || !strings.Contains(out, mine) || strings.Contains(out, theirs) {
		t.Errorf("claude's context:\n%s", out)
	}
	out = gpt.ok("get_context", nil)
	if !strings.Contains(out, "memories: 1 ") || !strings.Contains(out, theirs) || strings.Contains(out, mine) {
		t.Errorf("gpt's context:\n%s", out)
	}
	if out := gpt.ok("recall", map[string]any{"query": "部署", "deep": true}); strings.Contains(out, mine) {
		t.Errorf("gpt recalled claude's memory:\n%s", out)
	}
	if out := gpt.ok("expand", map[string]any{"ids": []string{mine}}); out != "no memories with those ids" {
		t.Errorf("gpt read claude's memory by id:\n%s", out)
	}
	// A session of one memory means nothing to the other.
	claudeSession := sessionID.FindString(claude.ok("get_context", nil))
	if _, err := gpt.call("remember", map[string]any{"session_id": claudeSession, "gist": "g", "body": "b"}); err == nil || !strings.Contains(err.Error(), "unknown session_id") {
		t.Errorf("gpt wrote with claude's session id: %v", err)
	}

	// One memory's token does not open the other.
	if sess, err := srv.dial("gpt", claudeToken); err == nil {
		sess.Close()
		t.Error("claude's token opened gpt's memory")
	}

	// Two files, each holding one life.
	for name, want := range map[string]int64{"claude": 1, "gpt": 1} {
		st, err := Describe(context.Background(), dir, name)
		if err != nil || st.Memories != want || !st.HasToken || st.LastEventAt.IsZero() {
			t.Errorf("%s: %+v (err %v), want %d memory and a token", name, st, err, want)
		}
	}
}

func TestOnlyTheRightTokenOpensAMemory(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "claude")
	other := create(t, dir, "gpt")
	srv := run(t, dir, Config{})

	if status, _ := srv.post("/claude/mcp", "Bearer "+token); status != http.StatusOK {
		t.Fatalf("the right token: status %d, want 200", status)
	}
	if status, _ := srv.post("/claude/mcp", "bearer "+token); status != http.StatusOK {
		t.Errorf("the scheme is case-insensitive: status %d, want 200", status)
	}

	var first string
	for name, tc := range map[string]struct{ path, auth string }{
		"no header":                 {"/claude/mcp", ""},
		"wrong token":               {"/claude/mcp", "Bearer nope"},
		"wrong scheme":              {"/claude/mcp", "Basic " + token},
		"prefix only":               {"/claude/mcp", "Bearer " + token[:20]},
		"another memory's token":    {"/claude/mcp", "Bearer " + other},
		"the stored hash":           {"/claude/mcp", "Bearer " + hashToken(token)},
		"no such memory":            {"/nobody/mcp", "Bearer " + token},
		"no such memory, no header": {"/nobody/mcp", ""},
		"a name that cannot exist":  {"/Not-A-Name!/mcp", "Bearer " + token},
		"the file name":             {"/claude.ziwo/mcp", "Bearer " + token},
	} {
		status, body := srv.post(tc.path, tc.auth)
		if status != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, status)
		}
		// A wrong token and a name that names nothing must look the same.
		if first == "" {
			first = body
		} else if body != first {
			t.Errorf("%s: body %q differs from %q", name, body, first)
		}
	}

	resp, err := http.Get(srv.url + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("healthz: status %d, want 200 without a token", resp.StatusCode)
	}
	for _, path := range []string{"/mcp", "/", "/claude", "/claude/mcp/extra"} {
		if status, _ := srv.post(path, "Bearer "+token); status != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, status)
		}
	}
}

func TestTheFileHoldsOnlyTheHashOfItsToken(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "claude")
	srv := run(t, dir, Config{})
	srv.connect("claude", token).remember("一件事", "正文")

	files, err := filepath.Glob(filepath.Join(dir, "*"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no files in the data directory: %v", err)
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(token)) || bytes.Contains(data, []byte(strings.TrimPrefix(token, "ziwo_"))) {
			t.Errorf("%s contains the token", filepath.Base(f))
		}
	}
	if info, err := os.Stat(Path(dir, "claude")); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Errorf("the memory file is readable by others: %v, %v", info.Mode().Perm(), err)
	}
}

func TestATokenCanBeReplacedWhileServing(t *testing.T) {
	dir := t.TempDir()
	oldToken := create(t, dir, "claude")
	srv := run(t, dir, Config{})
	before := srv.connect("claude", oldToken)
	id := before.remember("换令牌之前的事", "正文")

	newToken, err := NewToken(context.Background(), dir, "claude")
	if err != nil || newToken == oldToken {
		t.Fatalf("new token: %q, %v", newToken, err)
	}

	// The connection that was open under the old token is shut out too.
	if out, err := before.call("recall", map[string]any{"query": "令牌"}); err == nil {
		t.Errorf("the old token still works on an open connection: %s", out)
	}
	if status, _ := srv.post("/claude/mcp", "Bearer "+oldToken); status != http.StatusUnauthorized {
		t.Errorf("the old token: status %d, want 401", status)
	}
	after := srv.connect("claude", newToken)
	if out := after.ok("recall", map[string]any{"query": "令牌"}); !strings.Contains(out, id) {
		t.Errorf("with the new token the memory is as it was, got:\n%s", out)
	}

	if _, err := NewToken(context.Background(), dir, "nobody"); !errors.Is(err, ErrUnknown) {
		t.Errorf("new token for a memory that does not exist: %v, want %v", err, ErrUnknown)
	}
	if _, err := os.Stat(Path(dir, "nobody")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("asking for a token created a memory: %v", err)
	}
}

func TestAMemoryCreatedWhileServingIsServed(t *testing.T) {
	dir := t.TempDir()
	srv := run(t, dir, Config{})
	if status, _ := srv.post("/late/mcp", "Bearer whatever"); status != http.StatusUnauthorized {
		t.Fatalf("before it exists: status %d, want 401", status)
	}

	token := create(t, dir, "late")
	c := srv.connect("late", token)
	if out := c.ok("get_context", nil); !strings.Contains(out, "No memories yet") {
		t.Errorf("a new memory's context:\n%s", out)
	}
}

func TestAFirstRequestFromManyAtOnceOpensTheMemoryOnce(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "claude")
	srv := run(t, dir, Config{})

	var wg sync.WaitGroup
	ids := make([]string, 8)
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sess, err := srv.dial("claude", token)
			if err != nil {
				t.Errorf("client %d: %v", i, err)
				return
			}
			defer sess.Close()
			c := &client{t: t, sess: sess}
			out, err := c.call("get_context", nil)
			if err != nil {
				t.Errorf("client %d: %v", i, err)
				return
			}
			out, err = c.call("remember", map[string]any{"session_id": sessionID.FindString(out),
				"gist": "同时写入 " + string(rune('a'+i)), "body": "正文"})
			if err != nil {
				t.Errorf("client %d: %v", i, err)
				return
			}
			ids[i] = memoryID.FindString(out)
		}()
	}
	wg.Wait()

	// Every write landed, each in its own place.
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if len(seen) != len(ids) || seen[""] {
		t.Fatalf("ids = %v, want %d different ones", ids, len(ids))
	}
	counts, err := srv.h.Open(context.Background(), "claude")
	if err != nil || counts.Total() != int64(len(ids)) {
		t.Errorf("memories = %+v (err %v), want %d", counts, err, len(ids))
	}
}

func TestNoAuthServesWithoutTokens(t *testing.T) {
	dir := t.TempDir()
	create(t, dir, "claude")
	srv := run(t, dir, Config{NoAuth: true})

	c := srv.connect("claude", "")
	if out := c.ok("get_context", nil); !strings.Contains(out, "No memories yet") {
		t.Errorf("context without a token:\n%s", out)
	}
	// With nothing to keep from anyone, a wrong name is called a wrong name.
	if status, body := srv.post("/nobody/mcp", ""); status != http.StatusNotFound || !strings.Contains(body, "ziwo new") {
		t.Errorf("unknown memory: status %d, body %q; want 404 saying how to create one", status, body)
	}
}

func TestAFileThatCannotBeOpenedDoesNotStopTheOthers(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "claude")
	if err := os.WriteFile(Path(dir, "broken"), []byte("this is not a memory file, it is just text\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := run(t, dir, Config{})

	if _, err := srv.h.Open(context.Background(), "broken"); err == nil {
		t.Error("a file that is not a memory was opened")
	}
	if status, body := srv.post("/broken/mcp", "Bearer "+token); status != http.StatusServiceUnavailable || strings.Contains(body, dir) {
		t.Errorf("broken memory: status %d, body %q; want 503 without the server's paths", status, body)
	}
	if out := srv.connect("claude", token).ok("get_context", nil); !strings.Contains(out, "session: ") {
		t.Errorf("the healthy memory next to it:\n%s", out)
	}
	if data, _ := os.ReadFile(Path(dir, "broken")); !strings.HasPrefix(string(data), "this is not a memory file") {
		t.Errorf("the file that could not be opened was changed: %q", data)
	}
}

func TestClosedHostRefusesRequests(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "claude")
	srv := run(t, dir, Config{})
	srv.connect("claude", token).remember("关闭之前的事", "正文")

	if err := srv.h.Close(); err != nil {
		t.Fatal(err)
	}
	if status, _ := srv.post("/claude/mcp", "Bearer "+token); status != http.StatusServiceUnavailable {
		t.Errorf("after Close: status %d, want 503", status)
	}
	// What was written is in the file.
	if st, err := Describe(context.Background(), dir, "claude"); err != nil || st.Memories != 1 {
		t.Errorf("after Close: %+v, %v", st, err)
	}
}

func TestNames(t *testing.T) {
	for name, valid := range map[string]bool{
		"claude": true, "gpt-5": true, "a": true, "my_ai": true, "0x": true,
		strings.Repeat("a", 32): true,
		"":                      false, "Claude": false, "-claude": false, "_x": false, "a b": false,
		"a/b": false, "..": false, "a.b": false, "记忆": false, "healthz": false,
		strings.Repeat("a", 33): false,
	} {
		if got := ValidName(name) == nil; got != valid {
			t.Errorf("ValidName(%q) = %v, want %v", name, got, valid)
		}
	}

	dir := t.TempDir()
	for _, name := range []string{"gpt", "claude"} {
		create(t, dir, name)
	}
	// Things in the directory that are not memories.
	for _, file := range []string{"notes.txt", "Upper.ziwo", "claude.ziwo.bak", "healthz.ziwo"} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "folder.ziwo"), 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := Names(dir)
	if err != nil || !reflect.DeepEqual(got, []string{"claude", "gpt"}) {
		t.Errorf("Names = %v (err %v), want [claude gpt]", got, err)
	}
	if _, err := Names(filepath.Join(dir, "missing")); err == nil {
		t.Error("Names of a directory that does not exist returned no error")
	}
}

func TestCreateDoesNotOverwrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data", "nested") // made on demand
	ctx := context.Background()
	token := create(t, dir, "claude")

	if again, err := Create(ctx, dir, "claude"); err == nil || again != "" {
		t.Fatalf("creating a memory that exists: token %q, err %v", again, err)
	}
	srv := run(t, dir, Config{})
	if status, _ := srv.post("/claude/mcp", "Bearer "+token); status != http.StatusOK {
		t.Errorf("after the refused create the first token gives %d, want 200", status)
	}

	for _, bad := range []string{"", "Claude", "../escape", "healthz"} {
		if _, err := Create(ctx, dir, bad); err == nil {
			t.Errorf("Create accepted the name %q", bad)
		}
	}
	if names, _ := Names(dir); !reflect.DeepEqual(names, []string{"claude"}) {
		t.Errorf("after the refused creates: %v", names)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.ziwo")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a name with a path in it reached outside the data directory: %v", err)
	}
}

func TestRebuildAndDescribe(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	token := create(t, dir, "claude")

	if st, err := Describe(ctx, dir, "claude"); err != nil || st.Memories != 0 || st.Events != 0 || !st.LastEventAt.IsZero() || !st.HasToken {
		t.Errorf("a new memory: %+v, %v", st, err)
	}

	srv := run(t, dir, Config{})
	c := srv.connect("claude", token)
	c.remember("第一件事", "正文")
	c.remember("第二件事", "正文")
	if err := srv.h.Close(); err != nil {
		t.Fatal(err)
	}

	// Two sessions and two memories.
	if st, err := Describe(ctx, dir, "claude"); err != nil || st.Memories != 2 || st.Events != 4 || time.Since(st.LastEventAt) > time.Minute {
		t.Errorf("after two writes: %+v, %v", st, err)
	}
	memories, events, err := Rebuild(ctx, dir, "claude", store.DefaultParams())
	if err != nil || memories != 2 || events != 4 {
		t.Errorf("rebuild: %d memories from %d events (err %v), want 2 from 4", memories, events, err)
	}
	bad := store.DefaultParams()
	bad.BaseStrength = -1
	if _, _, err := Rebuild(ctx, dir, "claude", bad); err == nil {
		t.Error("rebuild accepted a negative strength")
	}

	for name, call := range map[string]func() error{
		"describe": func() error { _, err := Describe(ctx, dir, "nobody"); return err },
		"rebuild":  func() error { _, _, err := Rebuild(ctx, dir, "nobody", store.DefaultParams()); return err },
	} {
		if err := call(); !errors.Is(err, ErrUnknown) {
			t.Errorf("%s of a memory that does not exist: %v, want %v", name, err, ErrUnknown)
		}
	}
	if names, _ := Names(dir); !reflect.DeepEqual(names, []string{"claude"}) {
		t.Errorf("asking about a memory that does not exist created it: %v", names)
	}
}

// logBuf collects log output from several goroutines.
type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// lines returns the log lines whose message is msg.
func (l *logBuf) lines(msg string) []string {
	var out []string
	for _, line := range strings.Split(l.String(), "\n") {
		if strings.Contains(line, "msg="+msg+" ") || strings.HasSuffix(line, "msg="+msg) {
			out = append(out, line)
		}
	}
	return out
}

func accessLogged(t *testing.T, dir string, cfg Config) (*running, *logBuf) {
	t.Helper()
	buf := &logBuf{}
	cfg.Logger = slog.New(slog.NewTextHandler(buf, nil))
	return run(t, dir, cfg), buf
}

func TestAccessLogSaysHowEachRequestWasAuthenticated(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "anna")
	r, buf := accessLogged(t, dir, Config{AccessLog: true})

	if code, _ := r.post("/anna/mcp", ""); code != 401 {
		t.Fatalf("no token: status %d", code)
	}
	if code, _ := r.post("/anna/mcp", "Bearer ziwo_wrong"); code != 401 {
		t.Fatalf("wrong token: status %d", code)
	}
	if code, _ := r.post("/anna/mcp", "Bearer "+token); code != 200 {
		t.Fatalf("right token: status %d", code)
	}
	if code, _ := r.post("/nobody/mcp", "Bearer "+token); code != 401 {
		t.Fatalf("unknown memory: status %d", code)
	}
	resp, err := http.Get(r.url + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	lines := buf.lines("request")
	if len(lines) != 5 {
		t.Fatalf("want 5 request lines, got %d:\n%s", len(lines), buf.String())
	}
	for i, want := range []string{"status=401 ", "status=401 ", "status=200 ", "status=401 ", "status=200 "} {
		if !strings.Contains(lines[i], want) {
			t.Errorf("line %d lacks %q: %s", i, want, lines[i])
		}
	}
	for i, want := range []string{"auth=none", "auth=rejected", "auth=ok", "auth=rejected"} {
		if !strings.Contains(lines[i], want) {
			t.Errorf("line %d lacks %q: %s", i, want, lines[i])
		}
	}
	if strings.Contains(lines[4], "auth=") || !strings.Contains(lines[4], "path=/healthz") {
		t.Errorf("healthz line should carry no auth: %s", lines[4])
	}
	for _, want := range []string{"method=POST", "path=/anna/mcp", "dur=", "agent=", "remote=127.0.0.1"} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("line lacks %q: %s", want, lines[0])
		}
	}
}

func TestAccessLogLeavesOutAuthWithoutAuth(t *testing.T) {
	dir := t.TempDir()
	create(t, dir, "anna")
	r, buf := accessLogged(t, dir, Config{AccessLog: true, NoAuth: true})
	if code, _ := r.post("/anna/mcp", ""); code != 200 {
		t.Fatalf("status %d", code)
	}
	lines := buf.lines("request")
	if len(lines) != 1 || strings.Contains(lines[0], "auth=") {
		t.Fatalf("want one line without auth:\n%s", buf.String())
	}
}

func TestAccessLogClientAddressAndVersion(t *testing.T) {
	h := New(Config{AccessLog: true, BehindProxy: true})
	buf := &logBuf{}
	h.log = slog.New(slog.NewTextHandler(buf, nil))
	req := httptest.NewRequest("GET", "/healthz?x=q", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	req.Header.Set("MCP-Protocol-Version", "2025-06-18")
	req.Header.Set("User-Agent", strings.Repeat("a", 300))
	h.Handler().ServeHTTP(httptest.NewRecorder(), req)
	line := buf.String()
	for _, want := range []string{"remote=203.0.113.7", "mcp_version=2025-06-18", "agent=" + strings.Repeat("a", 120) + " "} {
		if !strings.Contains(line, want) {
			t.Errorf("line lacks %q: %s", want, line)
		}
	}
	if strings.Contains(line, strings.Repeat("a", 121)) || strings.Contains(line, "10.0.0.1") {
		t.Errorf("agent not clipped or later hop logged: %s", line)
	}
}

func TestAccessLogNeverHoldsWhatAMemorySays(t *testing.T) {
	const (
		marker  = "zorblaxquint"
		marker2 = "frimplevonk"
	)
	dir := t.TempDir()
	token := create(t, dir, "anna")
	r, buf := accessLogged(t, dir, Config{AccessLog: true})
	c := r.connect("anna", token)
	c.remember(marker+" gist", marker+" body")
	c.call("recall", map[string]any{"query": marker})

	for _, path := range []string{"/anna/mcp?x=" + marker2, "/healthz?x=" + marker2} {
		req, _ := http.NewRequest(http.MethodPost, r.url+path, strings.NewReader(initialize))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}

	log := buf.String()
	if len(buf.lines("request")) < 4 || len(buf.lines("tool")) < 3 {
		t.Fatalf("expected request and tool lines:\n%s", log)
	}
	for _, secret := range []string{marker, marker2, token, "Bearer"} {
		if strings.Contains(log, secret) {
			t.Errorf("log holds %q:\n%s", secret, log)
		}
	}
}

func TestNoAccessLogLinesWhenOff(t *testing.T) {
	dir := t.TempDir()
	token := create(t, dir, "anna")
	r, buf := accessLogged(t, dir, Config{})
	r.post("/anna/mcp", "")
	c := r.connect("anna", token)
	c.remember("a gist", "a body")
	if got := buf.String(); strings.Contains(got, "msg=request") || strings.Contains(got, "msg=tool") {
		t.Fatalf("log holds access lines although off:\n%s", got)
	}
}

// flushRecorder is a response writer that counts flushes.
type flushRecorder struct {
	*httptest.ResponseRecorder
	flushes int
}

func (f *flushRecorder) Flush() { f.flushes++; f.ResponseRecorder.Flush() }

func TestAccessLogKeepsStreamingIntact(t *testing.T) {
	h := New(Config{AccessLog: true})
	buf := &logBuf{}
	h.log = slog.New(slog.NewTextHandler(buf, nil))
	var viaController error
	wrapped := h.logged(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, ok := w.(http.Flusher)
		if !ok {
			t.Error("wrapper hides http.Flusher")
			return
		}
		f.Flush()
		viaController = http.NewResponseController(w).Flush()
	}))
	rec := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
	wrapped.ServeHTTP(rec, httptest.NewRequest("GET", "/x/mcp", nil))
	if viaController != nil {
		t.Fatalf("ResponseController flush failed: %v", viaController)
	}
	if rec.flushes != 2 {
		t.Fatalf("underlying writer flushed %d times, want 2", rec.flushes)
	}
	if line := buf.String(); !strings.Contains(line, "status=200") {
		t.Fatalf("a flushed response should log 200: %s", line)
	}
	if _, ok := any(&record{ResponseWriter: rec}).(interface{ Unwrap() http.ResponseWriter }); !ok {
		t.Fatal("no Unwrap")
	}
}
