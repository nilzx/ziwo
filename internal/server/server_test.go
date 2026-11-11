package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nilzx/ziwo/internal/memory"
	"github.com/nilzx/ziwo/internal/store"
)

const testToken = "test-token"

// instance is a running server on a database file.
type instance struct {
	url   string
	close func()
}

func serve(t *testing.T, dbPath string) *instance {
	t.Helper()
	return serveWith(t, dbPath, Options{Token: testToken}, nil)
}

// serveWith starts a server whose memory reads the time from clock, or from
// the real clock when clock is nil.
func serveWith(t *testing.T, dbPath string, opt Options, clock func() time.Time) *instance {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, dbPath, store.DefaultParams())
	if err != nil {
		t.Fatal(err)
	}
	svc, err := memory.New(ctx, st, nil, memory.Config{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(svc, opt))
	in := &instance{url: ts.URL}
	closed := false
	in.close = func() {
		if closed {
			return
		}
		closed = true
		ts.CloseClientConnections()
		ts.Close()
		if err := svc.Close(); err != nil {
			t.Errorf("close service: %v", err)
		}
		if err := st.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	}
	t.Cleanup(in.close)
	return in
}

type withToken struct{ token string }

func (w withToken) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+w.token)
	return http.DefaultTransport.RoundTrip(r)
}

// client is one MCP client, as a desktop app or a CLI would be.
type client struct {
	t    *testing.T
	sess *mcp.ClientSession
}

func connect(t *testing.T, in *instance, name string) *client {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: name, Version: "1.0"}, nil)
	sess, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:             in.url + "/mcp",
		HTTPClient:           &http.Client{Transport: withToken{testToken}, Timeout: 10 * time.Second},
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatalf("%s: connect: %v", name, err)
	}
	t.Cleanup(func() { sess.Close() })
	return &client{t: t, sess: sess}
}

// call runs a tool and returns its text and whether it reported an error.
func (c *client) call(tool string, args map[string]any) (string, bool) {
	c.t.Helper()
	res, err := c.sess.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		c.t.Fatalf("%s: %v", tool, err)
	}
	var b strings.Builder
	for _, part := range res.Content {
		if tc, ok := part.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

func (c *client) ok(tool string, args map[string]any) string {
	c.t.Helper()
	out, isErr := c.call(tool, args)
	if isErr {
		c.t.Fatalf("%s failed: %s", tool, out)
	}
	return out
}

var (
	memoryID  = regexp.MustCompile(`m_[a-z2-9]{8}`)
	sessionID = regexp.MustCompile(`s_[a-z2-9]{8}`)
)

func TestTwoClientsShareOneMemory(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "ziwo.db")
	srv := serve(t, dbPath)

	// The desktop client starts a conversation and lives through something.
	desktop := connect(t, srv, "desktop-app")
	out := desktop.ok("get_context", map[string]any{"model": "model-a"})
	if !strings.Contains(out, "No memories yet") || !sessionID.MatchString(out) {
		t.Fatalf("first get_context:\n%s", out)
	}
	out = desktop.ok("remember", map[string]any{
		"gist":       "用户纠正了我对记忆系统的理解",
		"body":       "我把它当成了项目笔记本。用户说它该记的是经历、感受和经验，项目信息归仓库。",
		"moment":     "corrected",
		"outcome":    "我改了设计，用户说这正是他想要的",
		"lesson":     "设计类需求先问清这东西记什么、给谁用",
		"people":     []string{"用户"},
		"pointer":    "https://example.com/ziwo",
		"importance": 0.8,
	})
	id := memoryID.FindString(out)
	if id == "" {
		t.Fatalf("remember returned no id: %s", out)
	}

	// A different client, running a different model, opens the same memory.
	cli := connect(t, srv, "cli-agent")
	out = cli.ok("get_context", map[string]any{"model": "model-b"})
	for _, want := range []string{id, "corrected: 用户纠正了我对记忆系统的理解", "memories: 1 (0 core, 1 active",
		"first time this memory is loaded by model-b", "model-a"} {
		if !strings.Contains(out, want) {
			t.Errorf("cli get_context lacks %q:\n%s", want, out)
		}
	}

	out = cli.ok("recall", map[string]any{"query": "上次用户是怎么纠正我的"})
	if !strings.Contains(out, id) {
		t.Errorf("cli recall did not find the desktop memory:\n%s", out)
	}
	if strings.Contains(out, "项目笔记本") {
		t.Errorf("recall should return gists only, got the body:\n%s", out)
	}

	out = cli.ok("expand", map[string]any{"ids": []string{id}})
	for _, want := range []string{"项目笔记本", "outcome: 我改了设计", "lesson: 设计类需求", "people: 用户",
		"pointer: https://example.com/ziwo", "importance 0.8", "as model-a", "via desktop-app"} {
		if !strings.Contains(out, want) {
			t.Errorf("expand lacks %q:\n%s", want, out)
		}
	}

	// And the other way round.
	out = cli.ok("remember", map[string]any{
		"gist": "The user said the first deploy had failed before I joined", "body": "He told me the proxy rejected every request.",
		"source": "told",
	})
	second := memoryID.FindString(out)
	out = desktop.ok("recall", map[string]any{"query": "proxy"})
	if !strings.Contains(out, second) || !strings.Contains(out, "(told)") {
		t.Errorf("desktop recall did not find the cli memory, marked as told:\n%s", out)
	}

	// Restart the server on the same file: nothing is lost.
	desktop.sess.Close()
	cli.sess.Close()
	srv.close()
	srv = serve(t, dbPath)
	web := connect(t, srv, "web-connector")
	out = web.ok("get_context", nil)
	if !strings.Contains(out, "memories: 2 ") || !strings.Contains(out, id) || !strings.Contains(out, second) {
		t.Errorf("after restart:\n%s", out)
	}
	if out = web.ok("recall", map[string]any{"query": "纠正"}); !strings.Contains(out, id) {
		t.Errorf("recall after restart:\n%s", out)
	}
}

func TestMistakesComeBackAsToolErrors(t *testing.T) {
	srv := serve(t, filepath.Join(t.TempDir(), "ziwo.db"))
	c := connect(t, srv, "cli-agent")

	out, isErr := c.call("remember", map[string]any{"gist": "g", "body": "b", "moment": "tuesday"})
	if !isErr || !strings.Contains(out, "moment must be one of") || strings.Contains(out, "invalid input") {
		t.Errorf("bad moment: isError=%v text=%q", isErr, out)
	}
	if out, isErr := c.call("remember", map[string]any{"body": "b"}); !isErr {
		t.Errorf("missing gist was accepted: %q", out)
	}
	if out := c.ok("recall", map[string]any{"query": "anything"}); !strings.HasPrefix(out, "no matching memories") {
		t.Errorf("empty recall: %q", out)
	}
	if out := c.ok("expand", map[string]any{"ids": []string{"m_aaaaaaaa"}}); out != "no memories with those ids" {
		t.Errorf("unknown id: %q", out)
	}

	// A retried write is not stored twice.
	args := map[string]any{"gist": "同一件事", "body": "同样的话"}
	first := memoryID.FindString(c.ok("remember", args))
	again := c.ok("remember", args)
	if !strings.Contains(again, "already remembered as "+first) {
		t.Errorf("retry: %q, want the first id %s back", again, first)
	}
}

func TestToolsAreDescribed(t *testing.T) {
	srv := serve(t, filepath.Join(t.TempDir(), "ziwo.db"))
	c := connect(t, srv, "cli-agent")
	res, err := c.sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, tool := range res.Tools {
		got[tool.Name] = true
		if tool.Description == "" {
			t.Errorf("%s has no description", tool.Name)
		}
	}
	for _, want := range []string{"get_context", "remember", "recall", "expand"} {
		if !got[want] {
			t.Errorf("tool %s is missing", want)
		}
	}
	if len(got) != 4 {
		t.Errorf("tools = %v, want exactly four", got)
	}
	if init := c.sess.InitializeResult(); init == nil || !strings.Contains(init.Instructions, "autobiographical memory") {
		t.Errorf("the server did not send its instructions")
	}
}

func TestRequestsWithoutTheTokenAreRejected(t *testing.T) {
	srv := serve(t, filepath.Join(t.TempDir(), "ziwo.db"))
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}`

	for name, auth := range map[string]string{
		"no header":    "",
		"wrong token":  "Bearer nope",
		"wrong scheme": "Basic " + testToken,
		"prefix only":  "Bearer " + testToken[:4],
	} {
		req, _ := http.NewRequest(http.MethodPost, srv.url+"/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, resp.StatusCode)
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
}

// A reverse proxy on the same machine forwards requests to the loopback
// listener with the public host name in the Host header. Without
// BehindProxy that looks like a DNS rebinding attack and is refused.
func TestBehindProxyAcceptsThePublicHostName(t *testing.T) {
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}`
	post := func(in *instance) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, in.url+"/mcp", strings.NewReader(body))
		req.Host = "memory.example.com"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	direct := serve(t, filepath.Join(t.TempDir(), "ziwo.db"))
	if got := post(direct); got != http.StatusForbidden {
		t.Errorf("without BehindProxy: status %d, want 403", got)
	}
	proxied := serveWith(t, filepath.Join(t.TempDir(), "ziwo.db"), Options{Token: testToken, BehindProxy: true}, nil)
	if got := post(proxied); got != http.StatusOK {
		t.Errorf("with BehindProxy: status %d, want 200", got)
	}
}

// The whole life of a memory as a client sees it: written, faded to its gist,
// gone from ordinary recall, and brought back.
func TestMemoriesFadeAndComeBack(t *testing.T) {
	// The server's goroutines read the clock while the test moves it.
	var mu sync.Mutex
	now := time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(d)
	}
	srv := serveWith(t, filepath.Join(t.TempDir(), "ziwo.db"), Options{Token: testToken}, clock)
	c := connect(t, srv, "cli-agent")
	c.ok("get_context", nil)

	cat := memoryID.FindString(c.ok("remember", map[string]any{
		"gist": "用户给我看了他的猫", "body": "一只橘猫，名字叫年糕。"}))
	kept := memoryID.FindString(c.ok("remember", map[string]any{
		"gist": "用户第一次把整个项目交给我", "body": "他说相信我的判断。",
		"feeling": "被信任，这件事我不想忘", "feeling_intensity": 0.95}))

	// Forty days on, with nothing recalled.
	advance(40 * 24 * time.Hour)
	out := c.ok("get_context", nil)
	for _, want := range []string{"memories: 2 (1 core, 0 active, 1 faded, 0 archived)", "core, never fades:", kept, "(faded)"} {
		if !strings.Contains(out, want) {
			t.Errorf("day 40 get_context lacks %q:\n%s", want, out)
		}
	}
	if out := c.ok("recall", map[string]any{"query": "年糕"}); !strings.Contains(out, "deep=true") || strings.Contains(out, cat) {
		t.Errorf("day 40: an ordinary recall on a detail should find nothing and point at deep recall:\n%s", out)
	}
	if out := c.ok("recall", map[string]any{"query": "相信我的判断"}); !strings.Contains(out, kept) || !strings.Contains(out, "(core)") {
		t.Errorf("day 40: the core memory should be found by its details:\n%s", out)
	}

	// A hundred days more: it has left ordinary recall altogether.
	advance(100 * 24 * time.Hour)
	out = c.ok("get_context", nil)
	if !strings.Contains(out, "0 faded, 1 archived") || strings.Contains(out, cat) || !strings.Contains(out, "recall deep=true") {
		t.Errorf("day 140 get_context:\n%s", out)
	}
	if out := c.ok("recall", map[string]any{"query": "猫"}); strings.Contains(out, cat) {
		t.Errorf("day 140: an ordinary recall reached an archived memory:\n%s", out)
	}
	out = c.ok("recall", map[string]any{"query": "年糕", "deep": true})
	if !strings.Contains(out, cat) || !strings.Contains(out, "(archived)") {
		t.Fatalf("day 140: deep recall should find it, marked archived:\n%s", out)
	}

	// Having been recalled, it is active again. The write is asynchronous.
	deadline := time.Now().Add(5 * time.Second)
	for {
		out = c.ok("get_context", nil)
		if strings.Contains(out, "1 active") || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(out, "memories: 2 (1 core, 1 active, 0 faded, 0 archived)") || !strings.Contains(out, cat) {
		t.Errorf("after the deep recall:\n%s", out)
	}
	if out := c.ok("recall", map[string]any{"query": "年糕"}); !strings.Contains(out, cat) || strings.Contains(out, "archived") {
		t.Errorf("after the deep recall, an ordinary recall should find it again:\n%s", out)
	}

	// A feeling without words for it is refused.
	if out, isErr := c.call("remember", map[string]any{"gist": "g", "body": "b", "feeling_intensity": 0.5}); !isErr || !strings.Contains(out, "feeling_intensity needs a feeling") {
		t.Errorf("intensity without a feeling: isError=%v %q", isErr, out)
	}
}
