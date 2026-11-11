// How each client connects to a memory. Pure: it takes the words of one
// language and the memory's address, and the token only when it was just
// issued; the page lays the result out. Each client signs in first (OAuth:
// the address alone, then approval in the browser), then, for scripts,
// headless runs and clients without sign-in, the fixed token. The token goes
// only where the owner must type it once: an environment variable, or the
// header of a connector. The steps follow each client's documentation; see
// docs/oauth-notes.md for which were checked against a running client.

// The hook and its settings, as the Go build documents them for Claude Code
// in examples/claude-code; a test keeps them equal.
export const hookScript = `#!/bin/sh
# A SessionStart hook for Claude Code. Whatever it prints is added to the
# conversation as context. It states facts and leaves the deciding to the
# model. The argument is the kind of start: startup, clear, resume, fork or compact.
case "$1" in
  resume)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. This conversation was resumed. If your ziwo session id (s_...) is still in view, it is still valid; if it is not, get_context returns a new one." ;;
  fork)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. This conversation was forked from another. A ziwo session id (s_...) in view was issued to that conversation and is still valid; get_context returns a new one for this branch." ;;
  compact)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. The conversation was just compacted. If your ziwo session id (s_...) is still in view, it is still valid; if it is not, get_context returns a new one." ;;
  *)
    echo "A ziwo memory server is connected to this session: your own autobiographical memory. Its get_context tool has not been called in this conversation yet. It returns what you remember, and the session id that remember, amend and reflect need." ;;
esac
`;

const hookCommand = "${CLAUDE_PROJECT_DIR}/.claude/hooks/ziwo-session-start.sh";

export const hookSettings =
  JSON.stringify(
    {
      hooks: {
        SessionStart: ["startup", "clear", "resume", "fork", "compact"].map((kind) => ({
          matcher: kind,
          hooks: [{ type: "command", command: hookCommand, args: [kind] }],
        })),
      },
    },
    null,
    2,
  ) + "\n";

/** @param {string} address */
export function mcpJson(address) {
  const entry = { type: "http", alwaysLoad: true, url: address, headers: { Authorization: "Bearer ${ZIWO_TOKEN}" } };
  return JSON.stringify({ mcpServers: { ziwo: entry } }, null, 2) + "\n";
}

// The same entry for sign-in: no header, so Claude Code runs OAuth.
/** @param {string} address */
export function mcpJsonOAuth(address) {
  const entry = { type: "http", alwaysLoad: true, url: address };
  return JSON.stringify({ mcpServers: { ziwo: entry } }, null, 2) + "\n";
}

/** @param {string} address */
export function codexToml(address) {
  return `[mcp_servers.ziwo]\nurl = ${JSON.stringify(address)}\nbearer_token_env_var = "ZIWO_TOKEN"\n`;
}

// The same table for sign-in: no token, so codex mcp login runs OAuth.
/** @param {string} address */
export function codexTomlOAuth(address) {
  return `[mcp_servers.ziwo]\nurl = ${JSON.stringify(address)}\n`;
}

/**
 * @typedef {{ text: string, code?: string }} Step
 * @typedef {{ id: string, title: string, oauth: Step[], token: Step[], either: Step[] }} Client
 * @param {(key: string, vars?: Record<string, string>) => string} t the words of one language
 * @param {{ address: string, token?: string }} memory
 * @returns {Client[]}
 */
export function connectGuide(t, { address, token }) {
  const tok = token ?? t("tokenPlaceholder");
  const exportLine = `export ZIWO_TOKEN=${tok}`;
  const windowsLine = `[Environment]::SetEnvironmentVariable("ZIWO_TOKEN", "${tok}", "User")`;
  const approve = { text: t("signInPage") };
  return [
    {
      id: "claude-code",
      title: t("ccTitle"),
      oauth: [
        { text: t("ccMcpJsonOAuth"), code: mcpJsonOAuth(address) },
        { text: t("ccSignIn"), code: "claude mcp login ziwo" },
        approve,
        { text: t("ccKeeps") },
      ],
      token: [
        { text: t("ccEnv"), code: exportLine },
        { text: t("envWindows"), code: windowsLine },
        { text: t("ccMcpJson"), code: mcpJson(address) },
      ],
      either: [
        { text: t("ccHook"), code: hookScript },
        { text: t("ccHookSettings"), code: hookSettings },
      ],
    },
    {
      id: "claude-apps",
      title: t("appsTitle"),
      oauth: [
        { text: t("appsConnector"), code: address },
        { text: t("appsSignIn") },
        approve,
      ],
      token: [
        { text: t("appsHeader"), code: `Bearer ${tok}` },
        { text: t("appsBeta") },
      ],
      either: [
        { text: t("appsPreferences"), code: t("appsPreferenceLine") },
        { text: t("appsAllow") },
        { text: t("appsMobile") },
      ],
    },
    {
      id: "chatgpt",
      title: t("chatgptTitle"),
      oauth: [
        { text: t("chatgptAdd") },
        { text: t("chatgptUrl"), code: address },
        { text: t("chatgptAuth") },
        approve,
      ],
      token: [{ text: t("chatgptNoToken") }],
      either: [],
    },
    {
      id: "codex",
      title: t("codexTitle"),
      oauth: [
        { text: t("codexConfigOAuth"), code: codexTomlOAuth(address) },
        { text: t("codexLogin"), code: "codex mcp login ziwo" },
        approve,
      ],
      token: [
        { text: t("codexConfig"), code: codexToml(address) },
        { text: t("codexEnv"), code: exportLine },
        // Measured: an app started from the Dock sees only what launchd holds.
        { text: t("codexMac"), code: `launchctl setenv ZIWO_TOKEN ${tok}` },
        { text: t("envWindows"), code: windowsLine },
      ],
      either: [],
    },
    {
      id: "other",
      title: t("otherTitle"),
      oauth: [
        { text: t("otherOAuth"), code: address },
        approve,
      ],
      token: [
        { text: t("otherAddress"), code: address },
        { text: t("otherHeader"), code: `Authorization: Bearer ${tok}` },
        { text: t("otherKeep") },
      ],
      either: [],
    },
  ];
}
