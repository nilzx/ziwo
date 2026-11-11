package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nilzx/ziwo/internal/memory"
	"github.com/nilzx/ziwo/internal/store"
)

// instance is a running endpoint on a memory file.
type instance struct {
	url   string
	st    *store.Store
	close func()
}

func serve(t *testing.T, path string) *instance {
	t.Helper()
	return serveWith(t, path, Options{}, store.DefaultParams())
}

func serveWith(t *testing.T, path string, opt Options, params store.Params) *instance {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, path, store.Options{Params: params, Create: true})
	if err != nil {
		t.Fatal(err)
	}
	svc, err := memory.New(ctx, st, nil, memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(svc, opt))
	in := &instance{url: ts.URL, st: st}
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

// client is one MCP client, as a desktop app or a CLI would be.
type client struct {
	t    *testing.T
	sess *mcp.ClientSession
}

func connect(t *testing.T, in *instance, name string) *client {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: name, Version: "1.0"}, nil)
	sess, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:             in.url,
		HTTPClient:           &http.Client{Timeout: 10 * time.Second},
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

// begin starts a conversation and returns its session id.
func (c *client) begin(model string) string {
	c.t.Helper()
	out := c.ok("get_context", map[string]any{"model": model})
	id := sessionID.FindString(out)
	if id == "" {
		c.t.Fatalf("get_context returned no session id:\n%s", out)
	}
	return id
}

// remember writes a memory in the given session and returns its id.
func (c *client) remember(session, gist, body string) string {
	c.t.Helper()
	out := c.ok("remember", map[string]any{"session_id": session, "gist": gist, "body": body})
	id := memoryID.FindString(out)
	if id == "" {
		c.t.Fatalf("remember returned no id: %s", out)
	}
	return id
}

var (
	memoryID  = regexp.MustCompile(`m_[a-z2-9]{8}`)
	sessionID = regexp.MustCompile(`s_[a-z2-9]{8}`)
)

func TestTwoClientsShareOneMemory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.ziwo")
	srv := serve(t, path)

	// The desktop client starts a conversation and lives through something.
	desktop := connect(t, srv, "desktop-app")
	out := desktop.ok("get_context", map[string]any{"model": "model-a"})
	if !strings.Contains(out, "No memories yet") || !strings.HasPrefix(out, "session: s_") {
		t.Fatalf("first get_context:\n%s", out)
	}
	deskSession := sessionID.FindString(out)
	out = desktop.ok("remember", map[string]any{
		"session_id": deskSession,
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
	cliSession := sessionID.FindString(out)
	for _, want := range []string{id, "corrected: 用户纠正了我对记忆系统的理解", "memories: 1 (0 core, 1 active",
		"first time this memory is loaded by model-b", "model-a",
		// It is told that another conversation is under way.
		"Other conversations used this memory recently", deskSession + " via desktop-app as model-a"} {
		if !strings.Contains(out, want) {
			t.Errorf("cli get_context lacks %q:\n%s", want, out)
		}
	}
	if cliSession == deskSession {
		t.Fatalf("both conversations got session %s", cliSession)
	}

	out = cli.ok("recall", map[string]any{"query": "上次用户是怎么纠正我的", "session_id": cliSession})
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
		"session_id": cliSession,
		"gist":       "The user said the first deploy had failed before I joined", "body": "He told me the proxy rejected every request.",
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
	srv = serve(t, path)
	web := connect(t, srv, "web-connector")
	out = web.ok("get_context", nil)
	if !strings.Contains(out, "memories: 2 ") || !strings.Contains(out, id) || !strings.Contains(out, second) {
		t.Errorf("after restart:\n%s", out)
	}
	if out = web.ok("recall", map[string]any{"query": "纠正"}); !strings.Contains(out, id) {
		t.Errorf("recall after restart:\n%s", out)
	}
	// A session outlives the server process: the conversation that started
	// before the restart can go on writing.
	if out, isErr := web.call("remember", map[string]any{"session_id": deskSession, "gist": "重启之后接着聊", "body": "会话还在。"}); isErr {
		t.Errorf("a session from before the restart was refused: %s", out)
	}
}

// One conversation, continued on another device: a new connection from a
// different client that carries on with the session id it already holds.
func TestSameConversationOnAnotherDevice(t *testing.T) {
	srv := serve(t, filepath.Join(t.TempDir(), "test.ziwo"))
	ctx := context.Background()

	phone := connect(t, srv, "phone-app")
	session := phone.begin("model-a")
	first := phone.remember(session, "用户在手机上问了我一件事", "聊到一半他说换个地方继续。")

	desktop := connect(t, srv, "desktop-app")
	second := desktop.remember(session, "用户回到桌面端接着聊", "还是刚才那件事。")
	// A read made from the desk belongs to the same conversation too.
	desktop.ok("recall", map[string]any{"query": "用户", "session_id": session})

	ms, err := srv.st.Get(ctx, []string{first, second})
	if err != nil || len(ms) != 2 || ms[0].SessionID != session || ms[1].SessionID != session {
		t.Fatalf("the two memories are not in one session: %v, %+v", err, ms)
	}
	all, err := srv.st.ActiveSessions(ctx, time.Time{}, "", 10)
	if err != nil || len(all) != 1 {
		t.Fatalf("sessions = %d (err %v), want 1: a second device is not a second conversation", len(all), err)
	}

	// A conversation that really is new is told of one other, not two.
	other := connect(t, srv, "cli-agent")
	out := other.ok("get_context", nil)
	if !strings.Contains(out, "Other conversations used this memory recently") || strings.Count(out, session) != 1 {
		t.Errorf("a new conversation should be told of exactly one other:\n%s", out)
	}
}

func TestMistakesComeBackAsToolErrors(t *testing.T) {
	srv := serve(t, filepath.Join(t.TempDir(), "test.ziwo"))
	c := connect(t, srv, "cli-agent")
	session := c.begin("")

	out, isErr := c.call("remember", map[string]any{"session_id": session, "gist": "g", "body": "b", "moment": "tuesday"})
	if !isErr || !strings.Contains(out, "moment must be one of") || strings.Contains(out, "invalid input") {
		t.Errorf("bad moment: isError=%v text=%q", isErr, out)
	}
	if out, isErr := c.call("remember", map[string]any{"session_id": session, "body": "b"}); !isErr {
		t.Errorf("missing gist was accepted: %q", out)
	}
	// A write that does not say which conversation it belongs to is refused,
	// and the reply names what is missing.
	if out, isErr := c.call("remember", map[string]any{"gist": "g", "body": "b"}); !isErr || !strings.Contains(out, "session_id") {
		t.Errorf("no session id: isError=%v text=%q", isErr, out)
	}
	if out, isErr := c.call("remember", map[string]any{"session_id": "", "gist": "g", "body": "b"}); !isErr || !strings.Contains(out, "call get_context first") {
		t.Errorf("empty session id: isError=%v text=%q", isErr, out)
	}
	if out, isErr := c.call("remember", map[string]any{"session_id": "s_aaaaaaaa", "gist": "g", "body": "b"}); !isErr || !strings.Contains(out, "unknown session_id") || !strings.Contains(out, "get_context") {
		t.Errorf("unknown session id: isError=%v text=%q", isErr, out)
	}
	if memories, _, _ := srv.st.Counts(context.Background()); memories != 0 {
		t.Errorf("refused writes stored %d memories", memories)
	}

	if out := c.ok("recall", map[string]any{"query": "anything"}); !strings.HasPrefix(out, "no matching memories") {
		t.Errorf("empty recall: %q", out)
	}
	if out := c.ok("expand", map[string]any{"ids": []string{"m_aaaaaaaa"}}); out != "no memories with those ids" {
		t.Errorf("unknown id: %q", out)
	}
	// Reading is never refused over the session id.
	if out, isErr := c.call("recall", map[string]any{"query": "anything", "session_id": "s_aaaaaaaa"}); isErr {
		t.Errorf("recall with an unknown session id failed: %q", out)
	}

	// A retried write is not stored twice.
	args := map[string]any{"session_id": session, "gist": "同一件事", "body": "同样的话"}
	first := memoryID.FindString(c.ok("remember", args))
	again := c.ok("remember", args)
	if !strings.Contains(again, "already remembered as "+first) {
		t.Errorf("retry: %q, want the first id %s back", again, first)
	}

	// A feeling without words for it is refused.
	if out, isErr := c.call("remember", map[string]any{"session_id": session, "gist": "g", "body": "b", "feeling_intensity": 0.5}); !isErr || !strings.Contains(out, "feeling_intensity needs a feeling") {
		t.Errorf("intensity without a feeling: isError=%v %q", isErr, out)
	}
}

func TestToolsAreDescribed(t *testing.T) {
	srv := serve(t, filepath.Join(t.TempDir(), "test.ziwo"))
	c := connect(t, srv, "cli-agent")
	res, err := c.sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	required := map[string][]string{}
	for _, tool := range res.Tools {
		if tool.Description == "" {
			t.Errorf("%s has no description", tool.Name)
		}
		schema, _ := tool.InputSchema.(map[string]any)
		list, _ := schema["required"].([]any)
		names := []string{}
		for _, r := range list {
			names = append(names, fmt.Sprint(r))
		}
		required[tool.Name] = names
	}
	// What a client must send. The session id is required to write and
	// optional to read.
	want := map[string]string{
		"get_context": "",
		"remember":    "session_id gist body",
		"recall":      "query",
		"expand":      "ids",
	}
	if len(required) != len(want) {
		t.Errorf("tools = %v, want exactly %d", required, len(want))
	}
	for name, fields := range want {
		got, ok := required[name]
		if !ok {
			t.Errorf("tool %s is missing", name)
		} else if strings.Join(got, " ") != fields {
			t.Errorf("%s requires %v, want %q", name, got, fields)
		}
	}
	if init := c.sess.InitializeResult(); init == nil || !strings.Contains(init.Instructions, "autobiographical memory") {
		t.Errorf("the server did not send its instructions")
	}
}

// A reverse proxy on the same machine forwards requests to the loopback
// listener with the public host name in the Host header. Without
// BehindProxy that looks like a DNS rebinding attack and is refused.
func TestBehindProxyAcceptsThePublicHostName(t *testing.T) {
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}`
	post := func(in *instance) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, in.url, strings.NewReader(body))
		req.Host = "memory.example.com"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	direct := serve(t, filepath.Join(t.TempDir(), "test.ziwo"))
	if got := post(direct); got != http.StatusForbidden {
		t.Errorf("without BehindProxy: status %d, want 403", got)
	}
	proxied := serveWith(t, filepath.Join(t.TempDir(), "test.ziwo"), Options{BehindProxy: true}, store.DefaultParams())
	if got := post(proxied); got != http.StatusOK {
		t.Errorf("with BehindProxy: status %d, want 200", got)
	}
}

// The whole life of a memory as a client sees it: written, faded to its gist,
// gone from ordinary recall, and brought back. What moves it along is how
// much is lived through after it, not time: this test never waits.
func TestMemoriesFadeAndComeBack(t *testing.T) {
	// An ordinary memory fades once 13 newer ones are written and leaves
	// ordinary recall once 30 are.
	params := store.DefaultParams()
	params.BaseStrength = 10
	srv := serveWith(t, filepath.Join(t.TempDir(), "test.ziwo"), Options{}, params)
	c := connect(t, srv, "cli-agent")
	session := c.begin("")

	cat := c.remember(session, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")
	out := c.ok("remember", map[string]any{"session_id": session,
		"gist": "用户第一次把整个项目交给我", "body": "他说相信我的判断。",
		"feeling": "被信任，这件事我不想忘", "feeling_intensity": 0.95})
	kept := memoryID.FindString(out)
	lived := 0
	live := func(n int) {
		t.Helper()
		for i := 0; i < n; i++ {
			lived++
			c.remember(session, fmt.Sprintf("filler %d", lived), "padding")
		}
	}

	// Thirteen memories on, with neither coming to mind.
	live(13)
	out = c.ok("get_context", nil)
	for _, want := range []string{"memories: 15 (1 core, 13 active, 1 faded, 0 archived)", "core, never fades:", kept} {
		if !strings.Contains(out, want) {
			t.Errorf("13 memories on, get_context lacks %q:\n%s", want, out)
		}
	}
	if out := c.ok("recall", map[string]any{"query": "年糕"}); !strings.Contains(out, "deep=true") || strings.Contains(out, cat) {
		t.Errorf("13 memories on: an ordinary recall on a detail should find nothing and point at deep recall:\n%s", out)
	}
	if out := c.ok("recall", map[string]any{"query": "相信我的判断"}); !strings.Contains(out, kept) || !strings.Contains(out, "(core)") {
		t.Errorf("13 memories on: the core memory should be found by its details:\n%s", out)
	}

	// Seventeen more: it has left ordinary recall altogether.
	live(17)
	out = c.ok("get_context", nil)
	if !strings.Contains(out, "memories: 32 (1 core, 13 active, 17 faded, 1 archived)") || strings.Contains(out, cat) || !strings.Contains(out, "recall deep=true") {
		t.Errorf("30 memories on, get_context:\n%s", out)
	}
	if out := c.ok("recall", map[string]any{"query": "猫"}); strings.Contains(out, cat) {
		t.Errorf("30 memories on: an ordinary recall reached an archived memory:\n%s", out)
	}
	out = c.ok("recall", map[string]any{"query": "年糕", "deep": true})
	if !strings.Contains(out, cat) || !strings.Contains(out, "(archived)") {
		t.Fatalf("30 memories on: deep recall should find it, marked archived:\n%s", out)
	}

	// Having come to mind, it is active again. The write is asynchronous.
	deadline := time.Now().Add(5 * time.Second)
	for {
		out = c.ok("get_context", nil)
		if strings.Contains(out, "0 archived") || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(out, "memories: 32 (1 core, 14 active, 17 faded, 0 archived)") {
		t.Errorf("after the deep recall:\n%s", out)
	}
	if out := c.ok("recall", map[string]any{"query": "年糕"}); !strings.Contains(out, cat) || strings.Contains(out, "archived") || strings.Contains(out, "faded") {
		t.Errorf("after the deep recall, an ordinary recall should find it again:\n%s", out)
	}
}
