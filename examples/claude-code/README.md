# ziwo with Claude Code

These files were tried against Claude Code 2.1.322 in November 2026, with model claude-sonnet-5-5, in headless (`-p`) conversations against a local server. They have not been tried in the desktop, web or mobile apps. The samples are small (10 conversations per group, 28 for session identity), so the figures below show direction, not rates.

A web or mobile client can only be told about the memory through the server's own instructions, and it will sometimes skip loading it. A client with hooks can do better: the hook puts a note into every new conversation, so the model knows the memory is there before its first answer.

## Connect the memory

`mcp.json` shows the server entry. Copy it to `.mcp.json` in a project, or add the same entry to your user configuration, with your server's address and the name of the memory in the path. The token is read from the environment, so it stays out of the file:

```sh
export ZIWO_TOKEN=ziwo_...   # shown once by the admin page when the memory is created, and again when a new token is issued
```

The entry has `"alwaysLoad": true`. Claude Code defers MCP tools by default: at the start the model sees the server's instructions and the tool names, and must search for a tool before it can call it. With `alwaysLoad` the tools of this server are loaded up front, which also saves one round trip per conversation. Ten fresh single-turn conversations per group, with prompts unrelated to memory:

- Everyday questions: `get_context` was called in 9 of 10 with no hook, 10 of 10 with the hook, and 10 of 10 with `alwaysLoad`.
- Coding tasks in a small project: it was called in 10 of 10 in all three groups. What differed was when. It was the model's first action in 2 of 10 with no hook, 6 of 10 with the hook, and 10 of 10 with `alwaysLoad`.

None of these conversations wrote a memory. The prompts were small talk and read-only questions.

## Tell each conversation about it

Copy `hooks/ziwo-session-start.sh` to `.claude/hooks/` and merge `settings.json` into `.claude/settings.json`. SessionStart hooks also run in headless mode.

The hook runs when a conversation starts, is cleared, is resumed, is forked, or is compacted, and prints one or two sentences that Claude Code adds to the conversation. It states what is the case and leaves the deciding to the model:

- At a start or after a clear: the memory is connected and `get_context` has not been called yet.
- After a resume or a compaction: the session id may have dropped out of view. If it is still there it is still valid; if not, `get_context` returns a new one. A new one means the rest of the conversation is recorded as a second session. Nothing is lost by that; the grouping is just less exact.
- After a fork: a forked conversation carries the transcript of the one it was forked from, so it sees that conversation's session id. The hook says the id was issued to the other conversation and is still valid, and that `get_context` returns a new one for this branch. In the two runs measured, which did not have this hook, a fork wrote into the same session as the conversation it came from.

The hook matters most after a compaction. Over 20 compacted conversations, with the hook 10 of 10 kept the session and wrote cleanly. Without it, 1 of 10 called `get_context` again and was recorded as two sessions, and in 3 of 10 the first write after the compaction was refused and succeeded when retried: the model had called the tool without looking it up again. Across all 28 multi-turn conversations, 27 stayed one session and every intended write was stored. Resuming four times, forking, and writing twice in one conversation caused no problem in 8 of 8.

Two things about how this was measured. Each turn was a separate headless call that resumed the conversation, so the hook spoke before every turn; in an interactive session it speaks at the start and after a compaction. And these runs did not set `alwaysLoad`, which keeps the tools in view and may by itself prevent the refused writes; that has not been measured.

The hook never calls the server and never sees the conversation. What is remembered, and when, stays the model's decision.

## What the hook does not do

It does not remind the model to write anything down at the end. A conversation has no reliable end to hook into, and a reminder on every turn would push the model to write more than carries weight. The server's instructions already say when a moment is worth remembering.
