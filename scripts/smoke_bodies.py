#!/usr/bin/env python3
"""End-to-end check of the real ziwo binary, about 135 checks.

It runs the binary as a user would: creates memories from the command line,
serves them, talks MCP over HTTP as several clients, and checks what comes
back. It covers several memories behind one server, forgetting by experience,
one conversation on two devices, token replacement, restart, amending,
reflecting, reconstructed memories, check, sealed export and import, and the
upgrade of files written by the two earlier builds.

Usage:
  smoke_bodies.py <ziwo> <step2-ziwo or ''> <workdir> <fake_embed.py> [<b40-ziwo>]

  <ziwo>         the binary under test (make build)
  <step2-ziwo>   a build of commit b3a913d, the first prototype with a single
                 database; '' skips that upgrade test
  <workdir>      a scratch directory; it is deleted and recreated
  <fake_embed.py> the stand-in embeddings server next to this file
  <b40-ziwo>     a build of commit b40a5a2, which wrote log format 1; optional

To build an old binary:
  git worktree add /tmp/ziwo-old b40a5a2
  (cd /tmp/ziwo-old && go build -tags sqlite_fts5 -o /tmp/ziwo-b40 ./cmd/ziwo)
  git worktree remove --force /tmp/ziwo-old

It listens on 127.0.0.1:18391 and 18392. The expected counts are exact, so a
change to forgetting or to what a command prints shows up here first.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

BIN, OLD, WORK, FAKE = sys.argv[1:5]
PREV = sys.argv[5] if len(sys.argv) > 5 else ""  # the build before this one, with the multi-memory command line
PORT, EPORT = 18391, 18392
BASE = f"http://127.0.0.1:{PORT}"
DATA = os.path.join(WORK, "data")
failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  ok   " if ok else "  FAIL ") + name)
    if not ok:
        failures += 1
        for line in str(detail).splitlines()[:25]:
            print("       | " + line)


def has(name, text, want):
    check(name, want in text, f"wanted: {want}\n{text}")


def lacks(name, text, unwanted):
    check(name, unwanted not in text, f"unwanted: {unwanted}\n{text}")


def cli(*args, binary=None, env=None, expect=0):
    r = subprocess.run([binary or BIN, *args], capture_output=True, text=True, env=env)
    if expect is not None and r.returncode != expect:
        check(f"ziwo {' '.join(args)} exits {expect}", False, r.stdout + r.stderr)
    return r.stdout + r.stderr


class Client:
    """A bare MCP client over Streamable HTTP."""

    def __init__(self, url, token, name):
        self.url, self.token, self.name, self.sid, self.n = url, token, name, None, 0
        self.status = self._post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": name, "version": "1"}}})[0]
        if self.status == 200:
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _post(self, body):
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), method="POST", headers={
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        if self.sid:
            req.add_header("Mcp-Session-Id", self.sid)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                self.sid = resp.headers.get("Mcp-Session-Id") or self.sid
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def tool(self, name, **args):
        self.n += 1
        status, raw = self._post({"jsonrpc": "2.0", "id": self.n, "method": "tools/call",
                                  "params": {"name": name, "arguments": args}})
        if status != 200:
            return f"HTTP {status}: {raw.strip()}"
        for line in raw.splitlines():
            line = line.removeprefix("data: ")
            if line.startswith("{"):
                res = json.loads(line).get("result") or {}
                text = "".join(c.get("text", "") for c in res.get("content", []))
                return ("ERROR: " if res.get("isError") else "") + text
        return "unreadable reply: " + raw

    def begin(self, model=""):
        out = self.tool("get_context", model=model)
        m = re.search(r"s_[a-z2-9]{8}", out)
        return m.group(0) if m else ""

    def remember(self, session, gist, body, **more):
        out = self.tool("remember", session_id=session, gist=gist, body=body, **more)
        m = re.search(r"m_[a-z2-9]{8}", out)
        return m.group(0) if m else "(no id: " + out + ")"


def status(path, token=None):
    req = urllib.request.Request(BASE + path, data=b"{}", method="POST", headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def logstate(name="old"):
    """Log format, expand events, recall events, remember events that still hold text, and content rows."""
    import sqlite3
    c = sqlite3.connect(os.path.join(DATA, name + ".ziwo"))
    try:
        one = lambda q: c.execute(q).fetchone()[0]
        return "%s %d %d %d %d" % (one("select value from meta where key='log_format'"),
                                   one("select count(*) from events where kind='expand'"),
                                   one("select count(*) from events where kind='recall'"),
                                   one("select count(*) from events where kind='remember' and payload like '%gist%'"),
                                   one("select count(*) from contents"))
    finally:
        c.close()


def filebytes(name):
    return open(os.path.join(DATA, name + ".ziwo"), "rb").read()


server = None


def start(*flags, binary=None, env=None, health=BASE + "/healthz"):
    global server
    log = open(os.path.join(WORK, "ziwo.log"), "a")
    server = subprocess.Popen([binary or BIN, *flags], stderr=log, stdout=log, env=env)
    for _ in range(80):
        try:
            urllib.request.urlopen(health, timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    print("  FAIL the server did not start")
    print(open(os.path.join(WORK, "ziwo.log")).read()[-3000:])
    sys.exit(1)


def stop():
    server.send_signal(signal.SIGTERM)
    code = server.wait(timeout=15)
    check("the server stops cleanly on SIGTERM", code == 0, f"exit code {code}")


shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK)
embedder = subprocess.Popen([sys.executable, "-I", FAKE, str(EPORT)], stderr=open(os.path.join(WORK, "embed.log"), "w"))
try:
    print("== two memories, created from the command line")
    out = cli("new", "claude", "-dir", DATA)
    claude_token = (re.search(r"ziwo_[\w-]{43}", out) or [""])[0]
    has("ziwo new prints the endpoint", out, "/claude/mcp")
    check("and a token", bool(claude_token), out)
    gpt_token = (re.search(r"ziwo_[\w-]{43}", cli("new", "gpt", "-dir", DATA)) or [""])[0]
    has("creating it twice is refused", cli("new", "claude", "-dir", DATA, expect=1), "already exists")
    has("a name that is not a name is refused", cli("new", "Not/A/Name", "-dir", DATA, expect=1), "invalid memory name")
    out = cli("list", "-dir", DATA)
    has("ziwo list shows both", out, "claude")
    has("ziwo list shows both (gpt)", out, "gpt")
    lacks("ziwo list shows no token", out, "ziwo_")
    raw = b"".join(open(os.path.join(DATA, f), "rb").read() for f in os.listdir(DATA))
    check("the files hold no token", claude_token.encode() not in raw and gpt_token.encode() not in raw)
    check("the files are private", all(os.stat(os.path.join(DATA, f)).st_mode & 0o077 == 0 for f in os.listdir(DATA)),
          [oct(os.stat(os.path.join(DATA, f)).st_mode) for f in os.listdir(DATA)])

    print("== one server, strength 10: an ordinary memory fades after 13 newer ones, is archived after 30")
    serve = ["serve", "-dir", DATA, "-addr", f"127.0.0.1:{PORT}",
             "-embed-url", f"http://127.0.0.1:{EPORT}/v1/embeddings", "-embed-model", "fake-topic"]
    start(*serve, "-strength", "10")
    desktop = Client(BASE + "/claude/mcp", claude_token, "desktop-app")
    check("claude's token opens claude's memory", desktop.status == 200, desktop.status)
    ctx = desktop.tool("get_context", model="model-a")
    has("a new memory is empty", ctx, "No memories yet")
    session = re.search(r"s_[a-z2-9]{8}", ctx).group(0)
    cat = desktop.remember(session, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")
    kept = desktop.remember(session, "用户第一次把整个项目交给我", "他说相信我的判断。",
                            feeling="被信任，这件事我不想忘", feeling_intensity=0.95)

    print("== the other memory knows nothing of it")
    other = Client(BASE + "/gpt/mcp", gpt_token, "gpt-client")
    gsession = other.begin("gpt-x")
    has("gpt starts empty", other.tool("get_context"), "No memories yet")
    theirs = other.remember(gsession, "The user asked me to review a contract", "It took three rounds.")
    lacks("gpt cannot recall claude's memory", other.tool("recall", query="猫", deep=True), cat)
    has("gpt cannot read it by id", other.tool("expand", ids=[cat]), "no memories with those ids")
    has("gpt cannot write with claude's session", other.tool("remember", session_id=session, gist="g", body="b"), "unknown session_id")
    lacks("claude does not see gpt's memory", desktop.tool("recall", query="contract", deep=True), theirs)
    for name, path, token in [("no token", "/claude/mcp", None), ("a wrong token", "/claude/mcp", "ziwo_nope"),
                              ("gpt's token on claude", "/claude/mcp", gpt_token), ("a name that names nothing", "/nobody/mcp", claude_token)]:
        check(f"{name}: 401", status(path, token) == 401, status(path, token))
    check("healthz needs no token", urllib.request.urlopen(BASE + "/healthz").status == 200)

    print("== one conversation, continued on another device")
    phone = Client(BASE + "/claude/mcp", claude_token, "phone-app")
    onphone = phone.remember(session, "用户换到手机上接着聊", "还是刚才的话题。")
    full = phone.tool("expand", ids=[onphone])
    has("the write from the phone lands in the same session", full, "via desktop-app")
    has("writing without a session id is refused", phone.tool("remember", gist="g", body="b"), "session_id")
    third = Client(BASE + "/claude/mcp", claude_token, "cli-agent")
    ctx = third.tool("get_context", model="model-b")
    has("a new conversation is told of the other one", ctx, "Other conversations used this memory recently")
    check("of one, not two", ctx.count(session) == 1, ctx)
    has("and of the change of model", ctx, "first time this memory is loaded by model-b")

    print("== forgetting follows what is lived through")
    n = 0

    def live(k):
        global n
        for _ in range(k):
            n += 1
            desktop.remember(session, f"filler {n}", "padding")

    live(12)  # 13 newer than the cat, counting the one from the phone
    ctx = desktop.tool("get_context")
    has("13 newer memories: the cat has faded", ctx, "memories: 15 (1 core, 13 active, 1 faded, 0 archived)")
    out = desktop.tool("recall", query="年糕")
    lacks("an ordinary recall no longer reads its details", out, cat)
    has("and points at deep recall", out, "deep=true")
    has("the core memory is still found by its details", desktop.tool("recall", query="相信我的判断"), kept)
    has("the faded one is still found by meaning, marked", desktop.tool("recall", query="feline"), "(faded)")
    time.sleep(1.2)  # being listed is recorded in the background
    has("being listed brought it back within reach", desktop.tool("get_context"), "0 faded, 0 archived")
    live(32)
    ctx = desktop.tool("get_context")
    has("32 more: it has left ordinary recall", ctx, "memories: 47 (1 core, 13 active, 17 faded, 16 archived)")
    lacks("an archived memory is not shown at the start", ctx, cat)
    lacks("ordinary recall does not reach it by meaning", desktop.tool("recall", query="feline"), cat)
    out = desktop.tool("recall", query="年糕", deep=True)
    has("deep recall finds it", out, cat)
    has("marked archived", out, "(archived)")
    time.sleep(1.5)
    has("having come to mind it is within reach again", desktop.tool("get_context"), "memories: 47 (1 core, 14 active, 17 faded, 15 archived)")
    out = desktop.tool("recall", query="feline")
    has("and is found by meaning again", out, cat)
    lacks("as an active memory", out, "(")
    has("reading it in full works", desktop.tool("expand", ids=[cat], session_id=session), "名字叫年糕")

    print("== while the server runs")
    out = cli("list", "-dir", DATA)
    has("ziwo list reads a memory that is being served", out, "claude")
    check("with its 47 memories", bool(re.search(r"claude\s+47\s", out)), out)
    new_token = (re.search(r"ziwo_[\w-]{43}", cli("token", "claude", "-dir", DATA)) or [""])[0]
    check("ziwo token prints a new token", bool(new_token) and new_token != claude_token)
    has("the old token is shut out, on an open connection too", desktop.tool("recall", query="猫"), "HTTP 401")
    again = Client(BASE + "/claude/mcp", new_token, "desktop-app")
    has("the new token opens the same memory", again.tool("recall", query="feline"), cat)
    late_token = (re.search(r"ziwo_[\w-]{43}", cli("new", "late", "-dir", DATA)) or [""])[0]
    late = Client(BASE + "/late/mcp", late_token, "late-client")
    has("a memory created after the start is served", late.tool("get_context"), "No memories yet")
    stop()
    left = sorted(os.listdir(DATA))
    check("a stopped server leaves one file per memory", left == ["claude.ziwo", "gpt.ziwo", "late.ziwo"], left)

    print("== restart with the default strength: the same events, replayed")
    start(*serve)
    c = Client(BASE + "/claude/mcp", new_token, "desktop-app")
    has("with a strength of 100 nothing has faded", c.tool("get_context"), "memories: 47 (1 core, 46 active, 0 faded, 0 archived)")
    has("a session from before the restart can still write",
        c.tool("remember", session_id=session, gist="重启之后接着聊", body="会话还在。"), "remembered as")
    stop()
    out = cli("rebuild", "claude", "-dir", DATA)
    check("ziwo rebuild replays the log", bool(re.match(r"rebuilt 48 memories from \d+ events", out)), out)
    has("serving without tokens is refused off loopback",
        cli("serve", "-dir", DATA, "-no-auth", "-addr", "0.0.0.0:18399", expect=1), "-no-auth is only allowed")
    has("contradictory thresholds are refused", cli("serve", "-dir", DATA, "-fade-below", "0.01", expect=1),
        "archive threshold < fade threshold")
    check("ziwo -h exits 0", subprocess.run([BIN, "-h"], capture_output=True).returncode == 0)
    check("ziwo serve -h exits 0", subprocess.run([BIN, "serve", "-h"], capture_output=True).returncode == 0)

    print("== step 3: what a person can ask for in conversation")
    life_token = (re.search(r"ziwo_[\w-]{43}", cli("new", "life", "-dir", DATA)) or [""])[0]
    start(*serve, "-strength", "10")
    a = Client(BASE + "/life/mcp", life_token, "cli-agent")
    sa = a.begin("model-a")
    m1 = a.remember(sa, "用户让我做一个记忆系统", "我先问清了它要记什么 keptmark4v。")
    m2 = a.remember(sa, "用户纠正了我的理解", "他说要记的是经历。")
    private = a.remember(sa, "用户告诉我一件私事", "住址是 qx4private7k 路，后来让我删掉。")
    weather = a.remember(sa, "用户问了天气", "聊了几句。")
    b = Client(BASE + "/life/mcp", life_token, "desktop-app")
    sb = b.begin("model-a")
    m3 = b.remember(sb, "另一次我也先问清了需求", "用户说这样省了返工。")

    out = a.tool("amend", session_id=sa, action="prefer", text="不用记天气之类的闲聊", reason="用户说的")
    has("a rule about what to remember is saved", out, "preference saved as p_")
    has("and every later conversation is shown it", b.tool("get_context"), "不用记天气之类的闲聊")
    out = a.tool("amend", session_id=sa, action="correct", id=m2, gist="用户纠正了我对记忆系统的理解", reason="原来的梗概太含糊")
    fixed = (re.findall(r"m_[a-z2-9]{8}", out) or [""])[0]
    check("a correction is a new memory", bool(fixed) and fixed != m2, out)
    out = a.tool("recall", query="纠正", deep=True)
    has("the old version stays in the record, marked", out, f"(replaced by {fixed})")
    lacks("and leaves ordinary recall", a.tool("recall", query="纠正"), m2)
    has("a retracted memory is set aside", a.tool("amend", session_id=sa, action="retract", id=weather), "retracted")
    lacks("and is not recalled, even by a deep search", a.tool("recall", query="天气", deep=True), weather)
    has("erase says what it did", a.tool("amend", session_id=sa, action="erase", id=private, reason="用户让我删掉"), "gone for good")
    out = a.tool("expand", ids=[private])
    has("an erased memory shows only that it existed", out, "erased: what it said was deleted for good")
    lacks("and none of what it said", out, "qx4private7k")
    has("amending needs a session id", a.tool("amend", action="pin", id=m1), "session_id")

    print("== step 3: reflecting")
    out = a.tool("reflect", session_id=sa)
    batch = (re.search(r"b_[a-z2-9]{8}", out) or [""])[0]
    check("reflect hands out a batch", bool(batch), out)
    has("with the fragments in full", out, "keptmark4v")
    lacks("without what was set aside or erased", out, "天气")
    has("only one conversation reflects at a time", b.tool("reflect", session_id=sb), "another conversation is reflecting")
    has("a statement about oneself needs experiences from separate occasions",
        a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "self", "gist": "我动手前会先问清楚", "from": [m1, fixed]}]),
        "at least 3 experiences")
    out = a.tool("reflect", session_id=sa, batch=batch, entries=[
        {"kind": "episode", "gist": "我和用户把记忆系统的方向定了下来", "body": "先问清，再被纠正，最后定稿。", "from": [m1, fixed], "milestone": True},
        {"kind": "lesson", "gist": "设计类需求先问清它记什么", "body": "两次都因此少走了弯路。", "from": [m1, m3]},
        {"kind": "impression", "about": "用户", "gist": "说话直接，纠正时会讲原因", "from": [fixed]},
        {"kind": "self", "gist": "我动手前会先问清楚", "context": "做设计的时候", "from": [m1, fixed, m3]}], **{"pass": [m3]})
    made = re.findall(r"m_[a-z2-9]{8}", out)
    check("the round is written back", len(made) == 4 and "(self)" in out, out)
    ctx = Client(BASE + "/life/mcp", life_token, "web-connector").tool("get_context", model="model-b")
    has("a new conversation is shown what was said about oneself", ctx, "我动手前会先问清楚 (做设计的时候)")
    has("the milestone is core", ctx, "episode: 我和用户把记忆系统的方向定了下来 (milestone)")
    has("the lesson and the impression are listed", ctx, "impression of 用户")
    lacks("the fragments that went into the episode are not", ctx, m1)
    has("reflecting did not count as living through anything", ctx, "memories: 4 (1 core, 3 active, 0 faded, 0 archived)")
    has("the episode says what it is built on", a.tool("expand", ids=[made[0]]), f"built on: {m1}, {fixed}")

    print("== step 3: writing down the past from records, 320 accounts in one go")
    import datetime
    day0 = datetime.date(2026, 1, 1)
    for i in range(320):
        when = (day0 + datetime.timedelta(days=i % 300)).isoformat()
        r = a.tool("remember", session_id=sa, source="reconstructed", happened_at=when,
                   gist=f"旧会话 {i}：和用户做的第 {i} 件事", body="从旧会话记录里整理出来的。", pointer=f"~/.claude/projects/x/{i}.jsonl")
        if "remembered as" not in r:
            check("reconstructed write %d" % i, False, r)
            break
    ctx = a.tool("get_context")
    has("none of them arrived faded, and nothing that was there was pushed out", ctx, "memories: 324 (1 core, 323 active, 0 faded, 0 archived)")
    has("they are dated when they happened", a.tool("recall", query="旧会话 7：和用户做的第 7 件事"), "2026-01-08")
    has("a date is required", a.tool("remember", session_id=sa, source="reconstructed", gist="g", body="b"), "happened_at is required")
    for i in range(13):
        a.remember(sa, f"filler step3 {i}", "padding")
    # 13 lived moments later: the 320 accounts have faded together, the lesson and the impression outlast
    # them, and the fragment that reflection passed over has left ordinary recall.
    has("from here on they fade as more is lived", a.tool("get_context"), "memories: 337 (1 core, 15 active, 320 faded, 1 archived)")
    stop()
    data = filebytes("life")
    check("the erased text is not in the file", b"qx4private7k" not in data and "住址".encode() not in data)
    check("what was kept is", b"keptmark4v" in data)
    start(*serve, "-strength", "10")
    again = Client(BASE + "/life/mcp", life_token, "cli-agent")
    ctx = again.tool("get_context")
    has("after a restart the statement about oneself is still there", ctx, "我动手前会先问清楚")
    has("and the rule", ctx, "不用记天气之类的闲聊")
    has("and the erased memory is still only a mark", again.tool("expand", ids=[private]), "erased")
    stop()
    out = cli("rebuild", "life", "-dir", DATA, "-strength", "10")
    check("rebuild replays amendments and reflection", bool(re.match(r"rebuilt 343 memories from \d+ events", out)), out)

    print("== step 4: looking a memory over without reading it")
    out = cli("check", "life", "-dir", DATA)
    has("check finds no damage in a memory that was used", out, "problems: none")
    has("it gives figures", out, "343 memories written")
    has("it notices the moments that pile up", out, "[backlog] 333 moments have not been reflected on")
    lacks("it prints nothing a memory says", out, "keptmark4v")
    lacks("nor a gist", out, "记忆系统")

    print("== step 4: a sealed backup, made while serving, brought back elsewhere")
    keyed = {**os.environ, "ZIWO_EXPORT_KEY": "a passphrase long enough"}
    backup = os.path.join(WORK, "life.ziwo-export")
    has("an export needs a passphrase", cli("export", "life", "-dir", DATA, "-o", backup, env={**os.environ, "ZIWO_EXPORT_KEY": ""}, expect=1), "ZIWO_EXPORT_KEY")
    start(*serve, "-strength", "10")
    live = Client(BASE + "/life/mcp", life_token, "cli-agent")
    has("the memory's owner can run the same check", live.tool("check"), "problems: none")
    has("an export is made while the memory is served", cli("export", "life", "-dir", DATA, "-o", backup, env=keyed), "exported")
    stop()
    sealed_bytes = open(backup, "rb").read()
    check("the backup holds nothing in the clear", b"keptmark4v" not in sealed_bytes and "记忆系统".encode() not in sealed_bytes and life_token.encode() not in sealed_bytes)
    data2 = os.path.join(WORK, "data2")
    has("the wrong passphrase does not open it", cli("import", "life2", backup, "-dir", data2, env={**os.environ, "ZIWO_EXPORT_KEY": "not the right passphrase"}, expect=1), "wrong passphrase")
    damaged = os.path.join(WORK, "damaged.ziwo-export")
    open(damaged, "wb").write(sealed_bytes[:len(sealed_bytes) // 2] + bytes([sealed_bytes[len(sealed_bytes) // 2] ^ 1]) + sealed_bytes[len(sealed_bytes) // 2 + 1:])
    has("a backup that was changed does not open", cli("import", "life2", damaged, "-dir", data2, env=keyed, expect=1), "wrong passphrase, or the file was changed")
    check("a refused import leaves nothing behind", not os.path.exists(data2) or os.listdir(data2) == [], os.listdir(data2) if os.path.exists(data2) else "")
    out = cli("import", "life2", backup, "-dir", data2, env=keyed)
    has("the backup is brought back", out, "brought back 343 memories")
    has("with the token it had", out, "answers to the token it had")
    out = cli("check", "life2", "-dir", data2)
    has("the restored file's record is intact before it is ever served", out, "problems: none")
    start("serve", "-dir", data2, "-addr", f"127.0.0.1:{PORT}", "-strength", "10")
    r = Client(BASE + "/life2/mcp", life_token, "cli-agent")
    check("the restored memory opens with the old token", r.status == 200, r.status)
    ctx = r.tool("get_context")
    has("its owner is told it was brought back", ctx, "This memory was brought back on")
    has("it holds what the original held", ctx, "我动手前会先问清楚 (做设计的时候)")
    has("down to the counts", ctx, "memories: 337 (1 core, 15 active, 320 faded, 1 archived)")
    has("an erased memory is still only a mark", r.tool("expand", ids=[private]), "erased")
    has("and it can go on living", r.tool("remember", session_id=r.begin("model-a"), gist="还原之后的第一件事", body="正文"), "remembered as")
    stop()
    has("the restored memory checks out, and says it was restored", cli("check", "life2", "-dir", data2), "1 restores")

    if PREV:
        print("== a file written by the build before this one (log format 1)")
        pdir = os.path.join(WORK, "prev")
        prev_token = (re.search(r"ziwo_[\w-]{43}", cli("new", "prev", "-dir", pdir, binary=PREV)) or [""])[0]
        start("serve", "-dir", pdir, "-addr", f"127.0.0.1:{PORT}", binary=PREV)
        p = Client(BASE + "/prev/mcp", prev_token, "prev-client")
        ps = p.begin("model-prev")
        pid = p.remember(ps, "上一版写下的一件事", "正文里有 prevmark9d，那时正文还在事件里。", importance=0.6)
        p.tool("recall", query="上一版")
        p.tool("expand", ids=[pid])
        time.sleep(1.2)
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=15)
        check("the previous build put the text inside the event", b'"gist"' in open(os.path.join(pdir, "prev.ziwo"), "rb").read())
        shutil.copy(os.path.join(pdir, "prev.ziwo"), os.path.join(DATA, "prev.ziwo"))
        start(*serve)
        u = Client(BASE + "/prev/mcp", prev_token, "new-client")
        check("the copied file opens with the token it always had", u.status == 200, u.status)
        has("its memory is intact", u.tool("expand", ids=[pid]), "prevmark9d")
        has("and can be erased now", u.tool("amend", session_id=u.begin("model-new"), action="erase", id=pid), "gone for good")
        stop()
        check("its log is in the current format, with no text left in the events", logstate("prev").startswith("3 2 1 0 0"), logstate("prev"))
        check("and the erased text has left the file", b"prevmark9d" not in filebytes("prev"))
        r = subprocess.run([PREV, "list", "-dir", DATA], capture_output=True, text=True)
        has("the previous build refuses the upgraded file", r.stdout + r.stderr, "newer version")

    if OLD:
        print("== a file written by the previously published build")
        olddb = os.path.join(WORK, "old.db")
        start("-addr", f"127.0.0.1:{PORT}", "-db", olddb, binary=OLD, env={**os.environ, "ZIWO_TOKEN": "old-secret"})
        o = Client(BASE + "/mcp", "old-secret", "old-client")
        o.tool("get_context", model="model-old")
        oid = re.search(r"m_[a-z2-9]{8}", o.tool("remember", gist="旧版本写下的一件事", body="那时候还没有格式版本号。", importance=0.6)).group(0)
        ocore = re.search(r"m_[a-z2-9]{8}", o.tool("remember", gist="旧版本里不想忘的事", body="正文", importance=0.95)).group(0)
        o.tool("recall", query="旧版本")
        has("the old build reads it back", o.tool("expand", ids=[oid]), "那时候还没有格式版本号")
        time.sleep(1.2)
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=15)
        shutil.copy(olddb, os.path.join(DATA, "old.ziwo"))
        has("the old file is listed before it is served", cli("list", "-dir", DATA), "old")
        check("opening it brought its log to the current format: the old reading is a reading, and the text is out of the events",
              logstate() == "3 1 1 0 2", logstate())
        old_token = (re.search(r"ziwo_[\w-]{43}", cli("token", "old", "-dir", DATA)) or [""])[0]
        check("it is given a token", bool(old_token))
        start(*serve)
        u = Client(BASE + "/old/mcp", old_token, "new-client")
        ctx = u.tool("get_context", model="model-new")
        has("the upgraded memory holds both memories", ctx, "memories: 2 (1 core, 1 active, 0 faded, 0 archived)")
        has("its core memory is still core", ctx, ocore)
        has("and knows it ran as another model before", ctx, "model-old")
        has("its details are intact", u.tool("expand", ids=[oid]), "那时候还没有格式版本号")
        usession = re.search(r"s_[a-z2-9]{8}", ctx).group(0)
        has("it can be written to", u.tool("remember", session_id=usession, gist="升级之后的第一件事", body="正文"), "remembered as")
        stop()
        check("the new reading and the new memory are added in the new form", logstate() == "3 2 1 0 3", logstate())
        try:
            r = subprocess.run([OLD, "-db", os.path.join(DATA, "old.ziwo"), "-addr", f"127.0.0.1:{PORT}"],
                               capture_output=True, text=True, timeout=4, env={**os.environ, "ZIWO_TOKEN": "old-secret"})
            print("       (for the record, the old build on the upgraded file exits %d: %s)" % (
                r.returncode, (r.stdout + r.stderr).strip().splitlines()[-1][:200]))
        except subprocess.TimeoutExpired:
            print("       (for the record, the old build starts on the upgraded file without complaint)")
finally:
    if server and server.poll() is None:
        server.kill()
    embedder.kill()

print("SMOKE: all checks passed" if failures == 0 else f"SMOKE: {failures} FAILURES")
sys.exit(1 if failures else 0)
