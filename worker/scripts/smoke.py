#!/usr/bin/env python3
"""End-to-end check of the ziwo Worker, run locally with `wrangler dev --local`.

Port of ../../scripts/smoke_bodies.py (the check of the Go server) to the
Worker. It starts the Worker itself, creates memories through the admin
endpoint, talks MCP over HTTP as several clients, and checks what comes back.
The expected counts are exact.

Usage:
  npm run smoke            (from worker/)
  python3 scripts/smoke.py

It starts `npx wrangler dev --local` on a free port, with a random admin secret
given by --var and its state in a scratch directory under the system temp
directory (--persist-to), so it neither reads nor writes worker/.dev.vars and
leaves nothing in worker/.wrangler/state. It stops the server and deletes the
scratch directory at the end and on any failure. It never contacts a Cloudflare
account. Set SMOKE_VERBOSE=1 to print whole answers when a check fails; by
default it prints the check's name, what it wanted and the shape of what came
back (ids, figures, length), never an answer.

Ported groups: the admin endpoint; several memories behind one server and
their isolation; auth (no token, wrong token, another memory's token);
one conversation continued by a second client with the same session id, under
both protocol generations; time zones; token replacement; restart on the same
persist directory (twice); writing and its validation messages; recall and
expand; amending (each action); erasing (a tool of its own here); reflecting
(both steps); reconstructed memories; the check tool.

Left out:
  - anything that needs the forgetting parameters changed. The Go script's
    forgetting-by-experience checks rely on a base strength of 10; this script
    was written before the admin API could set the parameters and has not
    taken them up. What is checked instead is that nothing fades under the
    default strength of 100. The tests in test/ cover forgetting.
  - export and import (the sealed backup and its restore), which the admin
    API has had since; the tests in test/ cover them.
  - the upgrade of files written by older builds.
  - the command-line commands (new, list, token, rebuild, check, serve, -h).
  - embeddings and search by meaning.
"""
import atexit
import datetime
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.dirname(HERE)
VERBOSE = bool(os.environ.get("SMOKE_VERBOSE"))
failures = 0
passed = 0


# ---------------------------------------------------------------- checks

def shape(text):
    """What may be said about an answer on a failure: never the answer itself."""
    text = str(text)
    if text.startswith("ERROR: ") or text.startswith("HTTP "):
        return text[:300]  # the Worker's own words, fixed phrases
    found = re.findall(r"\b[a-z]_[a-z2-9]{8}\b", text)
    return f"{len(text)} characters, {len(text.splitlines())} lines, ids: {', '.join(found[:12])}"


def check(name, ok, detail=""):
    global failures, passed
    print(("  ok   " if ok else "  FAIL ") + name)
    if ok:
        passed += 1
    else:
        failures += 1
        for line in str(detail).splitlines()[:25]:
            print("       | " + line)


def has(name, text, want):
    check(name, want in text, f"wanted: {want}\n{text if VERBOSE else shape(text)}")


def lacks(name, text, unwanted):
    check(name, unwanted not in text, f"unwanted: {unwanted}\n{text if VERBOSE else shape(text)}")


def refused(name, text, want):
    """The call was answered with a tool error that says want."""
    check(name, text.startswith("ERROR: ") and want in text, f"wanted an error saying: {want}\n{text if VERBOSE else shape(text)}")


def count_is(name, text, needle, n):
    got = text.count(needle)
    check(name, got == n, f"wanted {n} of: {needle}, got {got}\n{text if VERBOSE else shape(text)}")


def first(pattern, text):
    m = re.search(pattern, text)
    return m.group(0) if m else ""


def mid(text):
    return first(r"m_[a-z2-9]{8}", text)


# ---------------------------------------------------------------- the Worker

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Worker:
    """`wrangler dev --local` in its own process group."""

    def __init__(self, scratch, secret):
        self.scratch, self.secret = scratch, secret
        self.persist = os.path.join(scratch, "state")
        self.port, self.iport = free_port(), free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.proc = None
        self.runs = 0

    def start(self):
        self.runs += 1
        log = open(os.path.join(self.scratch, f"wrangler-{self.runs}.log"), "w")
        env = {**os.environ,
               "WRANGLER_SEND_METRICS": "false",
               "WRANGLER_LOG_PATH": os.path.join(self.scratch, "wrangler-logs"),
               "WRANGLER_REGISTRY_PATH": os.path.join(self.scratch, "registry"),
               "NO_UPDATE_NOTIFIER": "1", "CI": "1"}
        self.proc = subprocess.Popen(
            ["npx", "wrangler", "dev", "--config", "wrangler.dev.jsonc", "--local", "--ip", "127.0.0.1", "--port", str(self.port),
             "--inspector-port", str(self.iport), "--persist-to", self.persist,
             "--var", f"ADMIN_SECRET:{self.secret}"],
            cwd=WORKER, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True)
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                urllib.request.urlopen(self.base + "/", timeout=2)
                return
            except urllib.error.HTTPError:
                return  # any answer will do: the Worker has no route for /
            except Exception:
                time.sleep(0.3)
        print("  FAIL the Worker did not start")
        try:
            print(open(os.path.join(self.scratch, f"wrangler-{self.runs}.log")).read()[-2000:])
        except OSError:
            pass
        sys.exit(1)

    def stop(self):
        if self.proc is None:
            return 0
        code = None
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            code = self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            code = self.proc.wait()
        # whatever is left of the group
        for _ in range(20):
            try:
                os.killpg(self.proc.pid, 0)
            except ProcessLookupError:
                break
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                break
            time.sleep(0.2)
        self.proc = None
        return code


# ---------------------------------------------------------------- HTTP

LEGACY, MODERN = "2025-06-18", "2026-07-28"


def http(method, url, headers=None, body=None, timeout=60):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode()


class Client:
    """A bare MCP client over Streamable HTTP, of either protocol generation."""

    def __init__(self, base, memory, token, name, gen="old"):
        self.url, self.token, self.name, self.gen = f"{base}/{memory}/mcp", token, name, gen
        self.sid, self.n = None, 0
        if gen == "old":
            self.status = self._rpc("initialize", {
                "protocolVersion": LEGACY, "capabilities": {}, "clientInfo": {"name": name, "version": "1"}}, 0)[0]
            if self.status == 200:
                self._rpc("notifications/initialized", {}, None)
        else:
            self.status = self._rpc("server/discover", {}, 0)[0]

    def _rpc(self, method, params, id_, tool=None):
        if self.gen == "new":
            params = {**params, "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientInfo": {"name": self.name, "version": "1"},
                "io.modelcontextprotocol/clientCapabilities": {}}}
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if id_ is not None:
            body["id"] = id_
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "User-Agent": "ziwo-smoke/1"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if self.gen == "new":
            headers["Mcp-Protocol-Version"] = MODERN
            headers["Mcp-Method"] = method
            if tool:
                headers["Mcp-Name"] = tool
        elif method != "initialize":
            headers["Mcp-Protocol-Version"] = LEGACY
        if self.sid:
            headers["Mcp-Session-Id"] = self.sid
        status, h, raw = http("POST", self.url, headers, json.dumps(body).encode())
        if status == 200 and h.get("Mcp-Session-Id") and method == "initialize":
            self.sid = h.get("Mcp-Session-Id")
        return status, raw

    def tool(self, name, **args):
        self.n += 1
        status, raw = self._rpc("tools/call", {"name": name, "arguments": args}, self.n, tool=name)
        if status != 200:
            return f"HTTP {status}: {raw.strip()}"
        for line in raw.splitlines():
            line = line.removeprefix("data: ")
            if line.startswith("{"):
                msg = json.loads(line)
                if "error" in msg:
                    return "RPC ERROR: " + json.dumps(msg["error"])[:300]
                res = msg.get("result") or {}
                text = "".join(c.get("text", "") for c in res.get("content", []))
                return ("ERROR: " if res.get("isError") else "") + text
        return "unreadable reply: " + raw[:200]

    def tools(self):
        self.n += 1
        status, raw = self._rpc("tools/list", {}, self.n)
        for line in raw.splitlines():
            line = line.removeprefix("data: ")
            if line.startswith("{"):
                return [t["name"] for t in (json.loads(line).get("result") or {}).get("tools", [])]
        return []

    def begin(self, model="", timezone=""):
        args = {"model": model}
        if timezone:
            args["timezone"] = timezone
        return first(r"s_[a-z2-9]{8}", self.tool("get_context", **args))

    def remember(self, session, gist, body, **more):
        out = self.tool("remember", session_id=session, gist=gist, body=body, **more)
        m = re.search(r"m_[a-z2-9]{8}", out)
        return m.group(0) if m else "(no id: " + out[:200] + ")"


def mcp_status(base, memory, token, scheme="Bearer", method="POST", path=None):
    """The HTTP status of an initialize request with the given credentials."""
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token is not None:
        headers["Authorization"] = f"{scheme} {token}"
    body = json.dumps({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
        "protocolVersion": LEGACY, "capabilities": {}, "clientInfo": {"name": "probe", "version": "1"}}}).encode()
    return http(method, f"{base}{path or '/' + memory + '/mcp'}", headers, body if method == "POST" else None)[0]


def admin(base, path, secret, method="POST"):
    headers = {"Authorization": f"Bearer {secret}"} if secret is not None else {}
    status, _, raw = http(method, base + path, headers, b"" if method == "POST" else None)
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"raw": raw}


TOKEN_RE = r"^ziwo_[\w-]{43}$"


def scan(directory):
    """Everything under directory, as bytes."""
    blob = b""
    for root, _, files in os.walk(directory):
        for f in files:
            try:
                blob += open(os.path.join(root, f), "rb").read()
            except OSError:
                pass
    return blob


# ---------------------------------------------------------------- the run

def run(w):
    base = w.base
    secret = w.secret
    t0 = time.time()

    print("== the admin endpoint: memories are created here, not on a command line")
    st, made = admin(base, "/admin/memories/claude", secret)
    claude_token = made.get("token", "")
    check("creating a memory answers 201", st == 201, st)
    check("with the endpoint", made.get("endpoint") == "/claude/mcp", made)
    check("and a token in the form ziwo_ plus 43 characters", bool(re.match(TOKEN_RE, claude_token)), len(claude_token))
    has("which is said to be shown once", made.get("note", ""), "shown this once")
    st, made = admin(base, "/admin/memories/gpt", secret)
    gpt_token = made.get("token", "")
    check("a second memory is created", st == 201 and bool(gpt_token) and gpt_token != claude_token, st)
    st, body = admin(base, "/admin/memories/claude", secret)
    check("creating it twice is refused with 409", st == 409, st)
    has("saying it already exists", body.get("error", ""), "already exists")
    st, body = admin(base, "/admin/memories/Not-A-Name", secret)
    check("a name that is not a name is refused with 400", st == 400, st)
    has("saying so", body.get("error", ""), "invalid memory name")
    st, body = admin(base, "/admin/memories/healthz", secret)
    check("healthz is not a name either", st == 400 and "invalid memory name" in body.get("error", ""), st)
    check("no admin secret: 401", admin(base, "/admin/memories/zz", None)[0] == 401)
    check("a wrong admin secret: 401", admin(base, "/admin/memories/zz", "nope")[0] == 401)
    check("a memory's own token is not the admin secret: 401", admin(base, "/admin/memories/zz", claude_token)[0] == 401)
    check("the admin endpoint takes POST only", admin(base, "/admin/memories/zz", secret, method="GET")[0] == 404)
    check("a refused call created nothing", mcp_status(base, "zz", claude_token) == 401)
    check("a token route for a memory that does not exist: 404", admin(base, "/admin/memories/zz/token", secret)[0] == 404)
    check("the token route needs the secret too", admin(base, "/admin/memories/claude/token", None)[0] == 401)

    print("== one server, several memories")
    desktop = Client(base, "claude", claude_token, "desktop-app")
    check("claude's token opens claude's memory", desktop.status == 200, desktop.status)
    names = desktop.tools()
    check("it serves the eight tools",
          sorted(names) == sorted(["get_context", "remember", "recall", "expand", "reflect", "amend", "erase", "check"]), names)
    ctx = desktop.tool("get_context", model="model-a")
    has("a new memory is empty", ctx, "No memories yet")
    has("and says what time it is, in UTC unless told", ctx, "(UTC)")
    session = first(r"s_[a-z2-9]{8}", ctx)
    check("get_context hands out a session id", bool(session), shape(ctx))
    cat = desktop.remember(session, "用户给我看了他的猫", "一只橘猫，名字叫年糕。")
    kept = desktop.remember(session, "用户第一次把整个项目交给我", "他说相信我的判断。",
                            feeling="被信任，这件事我不想忘", feeling_intensity=0.95)
    check("two memories were written", cat.startswith("m_") and kept.startswith("m_") and cat != kept, (cat, kept))
    has("recall finds one by its details", desktop.tool("recall", query="年糕"), cat)
    has("a recall names the zone its dates are in", desktop.tool("recall", query="年糕"), "time zone: UTC")
    has("the strongly felt one is core", desktop.tool("get_context"), "memories: 2 (1 core, 1 active, 0 faded, 0 archived)")

    print("== the other memory knows nothing of it")
    other = Client(base, "gpt", gpt_token, "gpt-client")
    gsession = other.begin("gpt-x")
    has("gpt starts empty", other.tool("get_context"), "No memories yet")
    theirs = other.remember(gsession, "The user asked me to review a contract", "It took three rounds.")
    lacks("gpt cannot recall claude's memory", other.tool("recall", query="猫", deep=True), cat)
    has("gpt cannot read it by id", other.tool("expand", ids=[cat]), "no memories with those ids")
    refused("gpt cannot write with claude's session",
            other.tool("remember", session_id=session, gist="g", body="b"), "unknown session_id")
    lacks("claude does not see gpt's memory", desktop.tool("recall", query="contract", deep=True), theirs)
    has("gpt's own memory is there for gpt", other.tool("recall", query="contract"), theirs)

    print("== auth")
    for name, memory, token, scheme in [
            ("no token", "claude", None, "Bearer"),
            ("a wrong token", "claude", "ziwo_nope", "Bearer"),
            ("an empty token", "claude", "", "Bearer"),
            ("gpt's token on claude", "claude", gpt_token, "Bearer"),
            ("claude's token on gpt", "gpt", claude_token, "Bearer"),
            ("a name that names nothing", "nobody", claude_token, "Bearer"),
            ("the right token under another scheme", "claude", claude_token, "Basic")]:
        st = mcp_status(base, memory, token, scheme)
        check(f"{name}: 401", st == 401, st)
    check("the scheme is read in any case", mcp_status(base, "claude", claude_token, "bearer") == 200)
    check("a path that is not a memory's: 404", mcp_status(base, "claude", claude_token, path="/Not-A-Name/mcp") == 404)
    check("another path under a memory: 404", mcp_status(base, "claude", claude_token, path="/claude/other") == 404)
    st, _, raw = http("POST", base + "/claude/mcp", {"Content-Type": "application/json"}, b"{}")
    check("a 401 says which token is wanted", st == 401 and "unauthorized" in raw, st)

    print("== one conversation, continued on another device")
    phone = Client(base, "claude", claude_token, "phone-app")
    onphone = phone.remember(session, "用户换到手机上接着聊", "还是刚才的话题。")
    full = phone.tool("expand", ids=[onphone])
    has("the write from the phone lands in the same session", full, "via desktop-app")
    has("and the answer names the zone its times are in", full, "time zone: UTC")
    refused("writing without a session id is refused", phone.tool("remember", gist="g", body="b"), "session_id is required")
    third = Client(base, "claude", claude_token, "cli-agent")
    ctx = third.tool("get_context", model="model-b")
    has("a new conversation is told of the other one", ctx, "Other conversations used this memory recently")
    count_is("of one, not two", ctx, session, 1)
    has("and which client it is", ctx, f"{session} via desktop-app as model-a")
    has("and of the change of model", ctx, "first time this memory is loaded by model-b")
    modern = Client(base, "claude", claude_token, "modern-app", gen="new")
    check("a client of the newer protocol generation is let in", modern.status == 200, modern.status)
    onmodern = modern.remember(session, "新版协议的客户端也接着这次会话", "同一个会话编号。")
    has("it continues the same session and is named by its own metadata",
        modern.tool("expand", ids=[onmodern]), "via desktop-app")
    msession = modern.begin("model-c")
    check("and can start a conversation of its own", bool(msession) and msession != session, msession)
    has("which is recorded under its own name",
        desktop.tool("get_context"), f"{msession} via modern-app as model-c")
    check("both generations write to the same memory",
          "memories: 4 (1 core, 3 active, 0 faded, 0 archived)" in desktop.tool("get_context"))

    print("== time zones")
    zoned = Client(base, "claude", claude_token, "zone-app")
    zs = zoned.begin("model-a", timezone="Asia/Shanghai")
    ctx = zoned.tool("get_context", model="model-a", timezone="Asia/Shanghai")
    has("get_context shows now in the zone it was told", ctx, "(Asia/Shanghai)")
    has("with its offset", ctx, "+08:00")
    ctx = zoned.tool("get_context", timezone="Mars/Base")
    has("a zone the runtime does not know is said not to be kept", ctx, 'was not recognised and was not kept')
    has("and the times are in UTC", ctx, "times are shown in UTC")
    has("a known zone given in other words is not refused", zoned.tool("get_context", timezone="UTC"), "(UTC)")
    when = zoned.remember(zs, "上海的一个夜晚", "记录里写的是晚上十一点半。", source="reconstructed",
                          happened_at="2026-02-01 23:30")
    out = zoned.tool("expand", ids=[when], session_id=zs)
    has("a date without a zone is read in the session's zone", out, "2026-02-01 23:30 +08:00")
    has("and the answer ends with that zone", out, "time zone: Asia/Shanghai")
    out = zoned.tool("expand", ids=[when])
    has("without a session the same memory is shown in UTC", out, "2026-02-01 15:30Z")
    has("and says so", out, "time zone: UTC")
    has("a recall in the session's zone says so", zoned.tool("recall", query="上海的一个夜晚", session_id=zs), "time zone: Asia/Shanghai")
    has("an ordinary date reaches the gist line", zoned.tool("recall", query="上海的一个夜晚", session_id=zs), "2026-02-01")
    out = zoned.tool("recall", query="nothing-by-this-name-qzv")
    has("an empty recall says so", out, "no matching memories")
    lacks("and has no zone line", out, "time zone:")

    print("== no forgetting under the default strength")
    for i in range(1, 44):
        desktop.remember(session, f"filler {i}", "padding")
    # claude now holds cat, kept, onphone, onmodern, the shanghai night and 43 fillers = 48
    ctx = desktop.tool("get_context")
    has("48 memories, none has faded", ctx, "memories: 48 (1 core, 47 active, 0 faded, 0 archived)")
    has("an old one is still recalled by its details", desktop.tool("recall", query="年糕"), cat)
    has("get_context shows only the latest eight", ctx, "recent:")
    count_is("eight of them", ctx[ctx.index("recent:"):], "\n[m_", 8)
    has("and says that moments wait for reflect", ctx, "moments have not been reflected on")

    print("== token replacement")
    st, body = admin(base, "/admin/memories/claude/token", secret)
    new_token = body.get("token", "")
    check("the token route answers 200 with a new token", st == 200 and bool(re.match(TOKEN_RE, new_token)) and new_token != claude_token, st)
    has("saying the old one no longer works", body.get("note", ""), "old token no longer works")
    has("the old token is shut out, on an open connection too", desktop.tool("recall", query="猫"), "HTTP 401")
    check("a new connection with the old token: 401", mcp_status(base, "claude", claude_token) == 401)
    again = Client(base, "claude", new_token, "desktop-app")
    check("the new token opens the same memory", again.status == 200, again.status)
    has("and it holds what it held", again.tool("recall", query="年糕"), cat)
    check("the other memory's token is untouched", other.tool("get_context").startswith("session:"))
    st, body = admin(base, "/admin/memories/late", secret)
    late_token = body.get("token", "")
    late = Client(base, "late", late_token, "late-client")
    has("a memory created while the server runs is served", late.tool("get_context"), "No memories yet")

    claude_files = len(scan(w.persist))
    print("== restart: the same state directory, the same memories")
    code = w.stop()
    check("the Worker stops", code is not None, code)
    blob = scan(w.persist)
    check("the files hold no token",
          not any(t.encode() in blob for t in (claude_token, new_token, gpt_token, late_token)))
    check("nor the admin secret", secret.encode() not in blob)
    check("and hold the state", claude_files > 0 and b"filler 17" in blob, claude_files)
    w.start()
    c = Client(base, "claude", new_token, "desktop-app")
    check("after the restart the new token still opens claude's memory", c.status == 200, c.status)
    has("nothing is lost", c.tool("get_context"), "memories: 48 (1 core, 47 active, 0 faded, 0 archived)")
    has("an old memory is read in full", c.tool("expand", ids=[cat]), "名字叫年糕")
    has("a session from before the restart can still write",
        c.tool("remember", session_id=session, gist="重启之后接着聊", body="会话还在。"), "remembered as")
    check("the old token is still shut out", mcp_status(base, "claude", claude_token) == 401)
    check("gpt's token still opens gpt", mcp_status(base, "gpt", gpt_token) == 200)
    has("gpt's memory is still there", Client(base, "gpt", gpt_token, "gpt-client").tool("recall", query="contract"), theirs)
    has("the late memory is still there and empty", Client(base, "late", late_token, "late-client").tool("get_context"), "No memories yet")
    check("a memory that exists cannot be created again", admin(base, "/admin/memories/late", secret)[0] == 409)
    st, body = admin(base, "/admin/memories/late/token", secret)
    check("a token can be replaced after a restart", st == 200 and body.get("token") != late_token, st)

    print("== writing: what is accepted and what is refused")
    st, body = admin(base, "/admin/memories/rules", secret)
    rules_token = body.get("token", "")
    r = Client(base, "rules", rules_token, "rules-client")
    rs = r.begin("model-r")
    ok = r.tool("remember", session_id=rs, gist="第一件有分量的事", body="正文 rulesmark1。", moment="breakthrough",
                outcome="结果 outcomemark", feeling="一点欣慰", feeling_intensity=0.4, lesson="教训 lessonmark",
                people=["小林", "小林", " 小周 ", ""], pointer="https://example.invalid/repo", importance=0.7)
    ok_id = mid(ok)
    has("a full memory is accepted", ok, "remembered as m_")
    out = r.tool("expand", ids=[ok_id], session_id=rs)
    has("its moment is its label", r.tool("recall", query="第一件有分量的事"), f"[{ok_id}]")
    has("the moment is shown in full", out, "breakthrough")
    has("importance", out, "importance 0.7")
    has("the feeling, with its intensity", out, "feeling: 一点欣慰 (intensity 0.4)")
    has("the people, once each and trimmed", out, "people: 小林, 小周")
    has("the pointer", out, "pointer: https://example.invalid/repo")
    has("the outcome and the lesson", out, "outcome: 结果 outcomemark")
    has("the lesson", out, "lesson: 教训 lessonmark")
    has("who wrote it", out, "via rules-client")
    again = r.tool("remember", session_id=rs, gist="第一件有分量的事", body="正文 rulesmark1。")
    has("the same memory twice in a row is recognised", again, f"already remembered as {ok_id}")
    told = r.remember(rs, "用户说他以前养过狗", "他说的，不是我经历的 toldmark。", source="told")
    has("a thing told is marked so", r.tool("recall", query="养过狗"), "(told)")
    has("and so in full", r.tool("expand", ids=[told]), "told")
    has("two memories stand so far", r.tool("get_context"), "memories: 2 (0 core, 2 active, 0 faded, 0 archived)")
    refused("a gist is required", r.tool("remember", session_id=rs, gist="  ", body="b"), "gist is required")
    refused("a body is required", r.tool("remember", session_id=rs, gist="g", body=""), "body is required")
    refused("a gist has a limit", r.tool("remember", session_id=rs, gist="长" * 201, body="b"),
            "gist is 201 characters, the limit is 200")
    refused("a body has a limit", r.tool("remember", session_id=rs, gist="g", body="长" * 6001),
            "body is 6001 characters, the limit is 6000")
    refused("an outcome has a limit", r.tool("remember", session_id=rs, gist="g", body="b", outcome="x" * 1001),
            "outcome is 1001 characters, the limit is 1000")
    refused("a pointer has a limit", r.tool("remember", session_id=rs, gist="g", body="b", pointer="x" * 501),
            "pointer is 501 characters, the limit is 500")
    refused("a moment must be one of the list", r.tool("remember", session_id=rs, gist="g", body="b", moment="sad"),
            "moment must be one of start, blocked, corrected, breakthrough, finished, emotion, other")
    refused("a source must be one of the list", r.tool("remember", session_id=rs, gist="g", body="b", source="dreamt"),
            "source must be one of lived, told, inferred, reconstructed")
    refused("importance has a range", r.tool("remember", session_id=rs, gist="g", body="b", importance=1.5),
            "importance must be between 0 and 1")
    refused("a negative importance too", r.tool("remember", session_id=rs, gist="g", body="b", importance=-0.1),
            "importance must be between 0 and 1")
    refused("feeling_intensity has a range", r.tool("remember", session_id=rs, gist="g", body="b", feeling="f", feeling_intensity=2),
            "feeling_intensity must be between 0 and 1")
    refused("an intensity needs a feeling", r.tool("remember", session_id=rs, gist="g", body="b", feeling_intensity=0.5),
            "feeling_intensity needs a feeling")
    refused("at most 16 people", r.tool("remember", session_id=rs, gist="g", body="b", people=[f"p{i}" for i in range(17)]),
            "at most 16 people per memory")
    refused("a session id that names nothing", r.tool("remember", session_id="s_aaaaaaaa", gist="g", body="b"),
            'unknown session_id "s_aaaaaaaa"')
    refused("happened_at goes with reconstructed only", r.tool("remember", session_id=rs, gist="g", body="b", happened_at="2026-01-01"),
            'happened_at goes with source "reconstructed" only')
    refused("a date is required for a reconstructed memory", r.tool("remember", session_id=rs, source="reconstructed", gist="g", body="b"),
            "happened_at is required")
    refused("a date that is not a date", r.tool("remember", session_id=rs, source="reconstructed", gist="g", body="b", happened_at="last week"),
            'cannot read "last week" as a date')
    refused("a date in the future", r.tool("remember", session_id=rs, source="reconstructed", gist="g", body="b", happened_at="2999-01-01"),
            "happened_at is in the future")
    print("  -- a call whose arguments do not fit is answered in the Worker's own words")
    refused("a missing session id leads", r.tool("remember", gist="g", body="b"),
            "session_id is required: call get_context first and pass the session id it returns")
    refused("a field of the wrong kind", r.tool("remember", session_id=rs, gist=5, body="b"), "gist must be text")
    refused("a number of the wrong kind", r.tool("remember", session_id=rs, gist="g", body="b", importance="high"),
            "importance must be a number")
    refused("a list of the wrong kind", r.tool("remember", session_id=rs, gist="g", body="b", people="小林"),
            "people must be a list of text")
    refused("a field the tool does not have", r.tool("remember", session_id=rs, gist="g", body="b", mood="x"),
            '"mood" is not a field')
    out = r.tool("remember", gist=5, mood="x")
    check("every fault is named, once, in one answer",
          out.startswith("ERROR: ") and all(s in out for s in ("session_id is required", "gist must be text", "body is required", '"mood" is not a field')),
          out[:300])
    refused("a whole number is wanted for a limit", r.tool("recall", query="g", limit=2.5), "limit must be a whole number")
    refused("a flag is true or false", r.tool("recall", query="g", deep="yes"), "deep must be true or false")
    has("a blank query lists the newest", r.tool("recall", query="  "), ok_id)
    has("recall without a query at all lists the newest", r.tool("recall"), ok_id)
    refused("ids are required", r.tool("expand", ids=[]), "ids is required")
    refused("at most ten ids", r.tool("expand", ids=[f"m_aaaaaaa{i}" for i in range(11)]), "at most 10 ids per call")
    has("an id that names nothing is just not found", r.tool("expand", ids=["m_aaaaaaaa"]), "no memories with those ids")
    has("a read is never refused over who asks", r.tool("expand", ids=[ok_id], session_id="s_aaaaaaaa"), ok_id)
    has("nothing refused above was written", r.tool("get_context"), "memories: 2 (0 core, 2 active, 0 faded, 0 archived)")

    print("== recall and expand")
    st, body = admin(base, "/admin/memories/life", secret)
    life_token = body.get("token", "")
    a = Client(base, "life", life_token, "cli-agent")
    sa = a.begin("model-a")
    m1 = a.remember(sa, "用户让我做一个记忆系统", "我先问清了它要记什么 keptmark4v。", people=["用户"])
    m2 = a.remember(sa, "用户纠正了我的理解", "他说要记的是经历。", moment="corrected")
    private = a.remember(sa, "用户告诉我一件私事", "住址是 qx4private7k 路，后来让我删掉。")
    weather = a.remember(sa, "用户问了天气", "聊了几句。")
    b = Client(base, "life", life_token, "desktop-app")
    sb = b.begin("model-a")
    m3 = b.remember(sb, "另一次我也先问清了需求", "用户说这样省了返工。")
    out = a.tool("recall", query="记忆系统", limit=1)
    check("limit says how many", out.count("[m_") == 1, shape(out))
    out = a.tool("recall", query="问清")
    check("several are found by a shared word", all(x in out for x in (m1, m3)), shape(out))
    lacks("a memory not about it is not", out, weather)
    has("an ordinary recall finds a memory by what its body says", a.tool("recall", query="keptmark4v"), m1)
    out = a.tool("expand", ids=[m1, m3])
    check("expand returns several in full", m1 in out and m3 in out and "keptmark4v" in out, shape(out))
    has("with the moment and its source", a.tool("expand", ids=[m2]), "corrected")
    has("the same id twice is read once", a.tool("expand", ids=[m1, m1]), m1)
    count_is("only once", a.tool("expand", ids=[m1, m1]), f"[{m1}]", 1)
    has("a listing is not marked", a.tool("recall", query="记忆系统"), m1)
    lacks("an active memory carries no mark", a.tool("recall", query="keptmark4v"), "(")

    print("== amending")
    out = a.tool("amend", session_id=sa, action="prefer", text="不用记天气之类的闲聊", reason="用户说的")
    has("a rule about what to remember is saved", out, "preference saved as p_")
    pref = first(r"p_[a-z2-9]{8}", out)
    has("and every later conversation is shown it", b.tool("get_context"), "不用记天气之类的闲聊")
    has("with its id", b.tool("get_context"), f"[{pref}]")
    has("a preference is dropped by id", a.tool("amend", session_id=sa, action="unprefer", id=pref, reason="改主意了"), f"preference {pref} dropped")
    lacks("and is no longer shown", b.tool("get_context"), "不用记天气之类的闲聊")
    refused("a preference that is not in force", a.tool("amend", session_id=sa, action="unprefer", id=pref), "no preference in force with id")
    a.tool("amend", session_id=sa, action="prefer", text="不用记天气之类的闲聊", reason="用户又说了")
    refused("prefer needs the rule", a.tool("amend", session_id=sa, action="prefer"), "text is required for prefer")
    refused("a rule is short", a.tool("amend", session_id=sa, action="prefer", text="长" * 301), "text is 301 characters, the limit is 300")
    out = a.tool("amend", session_id=sa, action="correct", id=m2, gist="用户纠正了我对记忆系统的理解", reason="原来的梗概太含糊")
    fixed = mid(out)
    check("a correction is a new memory", bool(fixed) and fixed != m2, shape(out))
    has("and says what stands in place of what", out, f"corrected: {fixed} now stands in place of {m2}")
    out = a.tool("recall", query="纠正", deep=True)
    has("the old version stays in the record, marked", out, f"(replaced by {fixed})")
    lacks("and leaves ordinary recall", a.tool("recall", query="纠正"), m2)
    out = a.tool("expand", ids=[fixed])
    has("what the correction left out is carried over", out, "他说要记的是经历。")
    has("the new memory says what it corrects", out, f"corrects: {m2}")
    refused("an old version is not pinned any more", a.tool("amend", session_id=sa, action="pin", id=m2),
            f"{m2} has been replaced by a correction ({fixed}): amend that one")
    refused("nor corrected twice", a.tool("amend", session_id=sa, action="correct", id=m2, gist="x"),
            f"{m2} has been replaced by a correction ({fixed}): amend that one")
    refused("a correction needs what to say instead", a.tool("amend", session_id=sa, action="correct", id=m1), "correct needs what to say instead")
    has("a retracted memory is set aside", a.tool("amend", session_id=sa, action="retract", id=weather), f"retracted {weather}")
    lacks("and is not recalled, even by a deep search", a.tool("recall", query="天气", deep=True), weather)
    has("but it can be read by id, marked", a.tool("expand", ids=[weather]), "retracted")
    has("restore undoes it", a.tool("amend", session_id=sa, action="restore", id=weather), f"restored {weather}")
    has("and it is recalled again", a.tool("recall", query="天气"), weather)
    a.tool("amend", session_id=sa, action="retract", id=weather)
    has("pin keeps a memory for good", a.tool("amend", session_id=sa, action="pin", id=m1), f"pinned {m1}")
    has("a pinned memory is core, marked", a.tool("get_context"), "(pinned)")
    has("unpin lets it fade again", a.tool("amend", session_id=sa, action="unpin", id=m1), f"unpinned {m1}")
    has("reweigh sets a new importance", a.tool("amend", session_id=sa, action="reweigh", id=m3, importance=0.8), f"importance of {m3} is now 0.8")
    has("and shows in full", a.tool("expand", ids=[m3]), "importance 0.8")
    refused("an importance out of range", a.tool("amend", session_id=sa, action="reweigh", id=m3, importance=0), "importance is required for reweigh")
    refused("another out of range", a.tool("amend", session_id=sa, action="reweigh", id=m3, importance=1.2), "importance is required for reweigh")
    refused("an action that is not one", a.tool("amend", session_id=sa, action="polish", id=m1),
            "action must be one of retract, restore, pin, unpin, reweigh, correct, prefer, unprefer")
    refused("amending needs a session id", a.tool("amend", action="pin", id=m1), "session_id")
    refused("amending needs an action", a.tool("amend", session_id=sa), "action is required")
    refused("amending needs an id", a.tool("amend", session_id=sa, action="pin"), "id is required for pin")
    refused("an id that names nothing", a.tool("amend", session_id=sa, action="pin", id="m_aaaaaaaa"), 'no memory with id "m_aaaaaaaa"')
    refused("a session that names nothing", a.tool("amend", session_id="s_aaaaaaaa", action="pin", id=m1), 'unknown session_id "s_aaaaaaaa"')
    refused("a reason has a limit", a.tool("amend", session_id=sa, action="pin", id=m1, reason="长" * 301), "reason is 301 characters, the limit is 300")
    out = a.tool("amend", session_id=sa, action="erase", id=private, reason="用户让我删掉")
    refused("erase is not an action of amend", out, "erase is a tool of its own: call erase with the id of the memory")
    lacks("and nothing was erased by it", a.tool("expand", ids=[private]), "erased")

    print("== erasing is a tool of its own")
    has("erase says what it did", a.tool("erase", session_id=sa, id=private, reason="用户让我删掉"), f"erased {private}: what it said is gone for good")
    out = a.tool("expand", ids=[private])
    has("an erased memory shows only that it existed", out, "erased: what it said was deleted for good")
    lacks("and none of what it said", out, "qx4private7k")
    lacks("nor in a deep search", a.tool("recall", query="qx4private7k", deep=True), private)
    refused("erase needs a session id", a.tool("erase", id=m3), "session_id is required")
    refused("erase needs an id (the tool's own field check speaks first)", a.tool("erase", session_id=sa), "id is required")
    refused("a blank id too", a.tool("erase", session_id=sa, id="  "), "id is required for erase")
    refused("an id that names nothing", a.tool("erase", session_id=sa, id="m_aaaaaaaa"), 'no memory with id "m_aaaaaaaa"')
    refused("a session that names nothing", a.tool("erase", session_id="s_aaaaaaaa", id=m3), 'unknown session_id "s_aaaaaaaa"')
    refused("a reason has a limit", a.tool("erase", session_id=sa, id=m3, reason="长" * 301), "reason is 301 characters, the limit is 300")
    refused("erasing twice", a.tool("erase", session_id=sa, id=private), f"{private} has been erased; there is nothing left to amend")
    refused("an erased memory is not amended", a.tool("amend", session_id=sa, action="pin", id=private),
            f"{private} has been erased; there is nothing left to amend")
    refused("an erased memory is not corrected", a.tool("amend", session_id=sa, action="correct", id=private, gist="x"),
            f"{private} has been erased")
    refused("erase has no action field", a.tool("erase", session_id=sa, id=m3, action="erase"), '"action" is not a field')
    lacks("the erased gist is not shown at the start of a conversation", b.tool("get_context"), "用户告诉我一件私事")

    print("== reflecting")
    out = a.tool("reflect", session_id=sa)
    batch = first(r"b_[a-z2-9]{8}", out)
    check("reflect hands out a batch", bool(batch), shape(out))
    has("with the fragments in full", out, "keptmark4v")
    lacks("without what was set aside or erased", out, "天气")
    lacks("nor the erased text", out, "qx4private7k")
    has("and the zone its times are in", out, "time zone: UTC")
    has("and how to write back", out, "Write back with reflect")
    refused("only one conversation reflects at a time", b.tool("reflect", session_id=sb), "another conversation is reflecting")
    refused("a batch cannot be written back without its id",
            a.tool("reflect", session_id=sa, entries=[{"kind": "lesson", "gist": "g", "body": "b", "from": [m1]}]),
            "batch is required to write back")
    refused("nothing to write back", a.tool("reflect", session_id=sa, batch=batch), "nothing to write back")
    refused("a batch that is not open",
            a.tool("reflect", session_id=sa, batch="b_aaaaaaaa", entries=[{"kind": "lesson", "gist": "g", "body": "b", "from": [m1]}]),
            'batch "b_aaaaaaaa" is not open')
    refused("a statement about oneself needs experiences from separate occasions",
            a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "self", "gist": "我动手前会先问清楚", "from": [m1, fixed]}]),
            "at least 3 experiences")
    refused("an entry of a kind that is not one", a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "poem", "gist": "g"}]),
            "kind must be one of episode, lesson, impression, self, reading (entry 1)")
    refused("an episode needs a body", a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "episode", "gist": "g", "from": [m1]}]),
            "body is required for episode (entry 1)")
    refused("an impression needs a name", a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "impression", "gist": "g", "from": [m1]}]),
            "about is required for an impression")
    refused("an entry is checked for its fields", a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "lesson", "body": "b"}]),
            "gist is required (entry 1)")
    refused("an entry with a field it does not have", a.tool("reflect", session_id=sa, batch=batch, entries=[{"kind": "lesson", "gist": "g", "mood": 1}]),
            '"mood" is not a field of an entry (entry 1)')
    refused("an unknown session", a.tool("reflect", session_id="s_aaaaaaaa"), 'unknown session_id "s_aaaaaaaa"')
    out = a.tool("reflect", session_id=sa, batch=batch, entries=[
        {"kind": "episode", "gist": "我和用户把记忆系统的方向定了下来", "body": "先问清，再被纠正，最后定稿。", "from": [m1, fixed], "milestone": True},
        {"kind": "lesson", "gist": "设计类需求先问清它记什么", "body": "两次都因此少走了弯路。", "from": [m1, m3]},
        {"kind": "impression", "about": "用户", "gist": "说话直接，纠正时会讲原因", "from": [fixed]},
        {"kind": "self", "gist": "我动手前会先问清楚", "context": "做设计的时候", "from": [m1, fixed, m3]}], **{"pass": [m3]})
    made = re.findall(r"m_[a-z2-9]{8}", out)
    check("the round is written back", len(made) == 4 and "(self)" in out and "(episode)" in out, shape(out))
    has("and says how many were left as they are", out, "1 left as they are")
    refused("a batch is written back once", a.tool("reflect", session_id=sa, batch=batch, entries=[
        {"kind": "lesson", "gist": "g", "body": "b", "from": [m1]}]), "is not open")
    ctx = Client(base, "life", life_token, "web-connector").tool("get_context", model="model-b")
    has("a new conversation is shown what was said about oneself", ctx, "我动手前会先问清楚 (做设计的时候)")
    has("the milestone is core", ctx, "episode: 我和用户把记忆系统的方向定了下来 (milestone)")
    has("the impression is listed", ctx, "impression of 用户")
    lacks("the fragments that went into the episode are not", ctx, m1)
    has("reflecting did not count as living through anything", ctx, "memories: 4 (1 core, 3 active, 0 faded, 0 archived)")
    has("the episode says what it is built on", a.tool("expand", ids=[made[0]]), f"built on: {m1}, {fixed}")
    has("an absorbed fragment says what it is part of", a.tool("expand", ids=[m1]), f"part of {made[0]}")
    has("afterwards nothing waits", a.tool("reflect", session_id=sa), "nothing waits to be reflected on")

    print("== writing down the past from records, 320 accounts in one go")
    day0 = datetime.date(2026, 1, 1)
    for i in range(320):
        when = (day0 + datetime.timedelta(days=i % 300)).isoformat()
        res = a.tool("remember", session_id=sa, source="reconstructed", happened_at=when,
                     gist=f"旧会话 {i}：和用户做的第 {i} 件事", body="从旧会话记录里整理出来的。", pointer=f"~/.claude/projects/x/{i}.jsonl")
        if "remembered as" not in res:
            check("reconstructed write %d" % i, False, res)
            break
    ctx = a.tool("get_context")
    has("none of them arrived faded, and nothing that was there was pushed out", ctx, "memories: 324 (1 core, 323 active, 0 faded, 0 archived)")
    has("they are dated when they happened", a.tool("recall", query="旧会话 7：和用户做的第 7 件事"), "2026-01-08")
    has("and marked as reconstructed", a.tool("recall", query="旧会话 7：和用户做的第 7 件事"), "reconstructed")
    for i in range(13):
        a.remember(sa, f"filler step3 {i}", "padding")
    has("13 lived moments later they have not faded: the default strength is 100",
        a.tool("get_context"), "memories: 337 (1 core, 336 active, 0 faded, 0 archived)")

    print("== looking a memory over without reading it")
    out = a.tool("check")
    has("check finds no damage in a memory that was used", out, "problems: none")
    has("it gives figures", out, "343 memories written")
    has("it counts the erasure", out, "1 erased")
    has("it notices the moments that pile up", out, "[backlog] 333 moments have not been reflected on")
    lacks("it prints nothing a memory says", out, "keptmark4v")
    lacks("nor a gist", out, "记忆系统")
    lacks("nor an erased text", out, "qx4private7k")
    has("it lists no restore", out, "0 restores")
    refused("check takes no arguments", a.tool("check", verbose=True), '"verbose" is not a field')
    out = Client(base, "claude", new_token, "desktop-app").tool("check")
    has("the same check on another memory", out, "problems: none")
    has("with that memory's own figures", out, "49 memories written")

    print("== restart again: reflection, rules and erasures are still there")
    w.stop()
    blob = scan(w.persist)
    check("the erased text is not in the files", b"qx4private7k" not in blob and "住址".encode() not in blob)
    check("what was kept is", b"keptmark4v" in blob)
    check("no token in the files after more use", not any(t.encode() in blob for t in (claude_token, new_token, gpt_token, life_token, rules_token)))
    w.start()
    again = Client(base, "life", life_token, "cli-agent")
    ctx = again.tool("get_context")
    has("after a restart the statement about oneself is still there", ctx, "我动手前会先问清楚")
    has("and the rule", ctx, "不用记天气之类的闲聊")
    has("and the counts", ctx, "memories: 337 (1 core, 336 active, 0 faded, 0 archived)")
    has("and the erased memory is still only a mark", again.tool("expand", ids=[private]), "erased")
    has("and the check still finds no damage", again.tool("check"), "problems: none")
    has("and the same figure", again.tool("check"), "343 memories written")
    has("and the same backlog", again.tool("check"), "333 moments have not been reflected on")
    has("an old session can go on writing", again.tool("remember", session_id=sa, gist="重启后继续写", body="正文"), "remembered as")
    has("reflection still works after a restart", again.tool("reflect", session_id=sa), "batch: b_")

    elapsed = time.time() - t0
    print(f"   ({elapsed:.0f} s)")


def main():
    scratch = tempfile.mkdtemp(prefix="ziwo-smoke-")
    secret = "smoke-" + os.urandom(16).hex()
    w = Worker(scratch, secret)

    def cleanup():
        try:
            w.stop()
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        w.start()
        run(w)
    except KeyboardInterrupt:
        print("  interrupted")
        global failures
        failures += 1
    finally:
        cleanup()
    print(f"SMOKE: {passed} passed, {failures} failed")
    print("SMOKE: all checks passed" if failures == 0 else f"SMOKE: {failures} FAILURES")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
