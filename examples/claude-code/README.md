# ziwo with Claude Code

These files have not been tried against a running Claude Code yet. They were written from the hooks reference and are the starting point for the end-to-end tests.

A web or mobile client can only be told about the memory through the server's own instructions, and it will sometimes skip loading it. A client with hooks can do better: the hook puts a note into every new conversation, so the model knows the memory is there before its first answer.

## Connect the memory

`mcp.json` shows the server entry. Copy it to `.mcp.json` in a project, or add the same entry to your user configuration, with your server's address and the name of the memory in the path. The token is read from the environment, so it stays out of the file:

```sh
export ZIWO_TOKEN=ziwo_...   # printed once by: ziwo new claude
```

## Tell each conversation about it

Copy `hooks/ziwo-session-start.sh` to `.claude/hooks/` and merge `settings.json` into `.claude/settings.json`.

The hook runs when a conversation starts, is cleared, is resumed, or is compacted, and prints one or two sentences that Claude Code adds to the conversation. It states what is the case and leaves the deciding to the model:

- At a start or after a clear: the memory is connected and `get_context` has not been called yet.
- After a resume or a compaction: the session id may have dropped out of view. If it is still there it is still valid; if not, `get_context` returns a new one. A new one means the rest of the conversation is recorded as a second session. Nothing is lost by that; the grouping is just less exact.

The hook never calls the server and never sees the conversation. What is remembered, and when, stays the model's decision.

## What the hook does not do

It does not remind the model to write anything down at the end. A conversation has no reliable end to hook into, and a reminder on every turn would push the model to write more than carries weight. The server's instructions already say when a moment is worth remembering.
