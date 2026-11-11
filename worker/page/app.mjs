// The admin page: what the owner of a deployment sees in a browser. It holds
// the admin secret in this module's memory only (gone on reload), calls the
// admin API of the same origin, and never shows what a memory says. Text is
// set with textContent only; nothing is ever parsed as HTML.

import { connectGuide } from "./connect.mjs";
import { makeH } from "./dom.mjs";
import {
  ApiError, defaultParams, makeApi, SecretError, memoryHash, namesMatch, paramNames, pickLanguage, reportGroups, route, sealedFileName,
  settingsChange,
} from "./logic.mjs";
import { minPassphrase, open, seal, SealError } from "./seal.mjs";
import { format, texts } from "./texts.mjs";

const state = {
  /** @type {"en" | "zh"} */
  lang: pickLanguage(navigator.languages ?? [navigator.language]),
  /** @type {ReturnType<typeof makeApi> | undefined} the secret lives in here, and only here */
  api: undefined,
  /** @type {{ name: string, token: string } | undefined} a token just issued, until the owner leaves its memory */
  issued: undefined,
  /** @type {{ name: string, lines: string[] } | undefined} what an import reported */
  flash: undefined,
  /** @type {string | undefined} what a deletion reported, shown once on the list */
  notice: undefined,
};

/** @param {string} key @param {Record<string, string | number>} [vars] */
function t(key, vars) {
  return format(texts[state.lang][key] ?? key, vars);
}

// Every element is built by h; text never becomes markup.
const h = makeH(document);

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const tools = /** @type {HTMLElement} */ (document.getElementById("tools"));

let ids = 0;
const nextId = (/** @type {string} */ p) => `${p}-${++ids}`;

function outBox() {
  return h("div", { class: "out", role: "status", "aria-live": "polite" });
}

/** @param {HTMLElement} out @param {...unknown} lines */
function say(out, ...lines) {
  out.classList.remove("error");
  out.replaceChildren(...lines.map((l) => (l instanceof Node ? l : h("p", { text: l }))));
}

/** @param {unknown} err a failure, or the page's own words for one */
function errorWords(err) {
  if (typeof err === "string") return err;
  if (err instanceof ApiError) return err.message; // as the API gave it
  if (err instanceof SecretError) return t("secretUnsendable");
  if (err instanceof SealError) return t(`seal-${err.code}`, { min: minPassphrase, message: err.message });
  return t("networkError", { message: err instanceof Error ? err.message : String(err) });
}

/** @param {HTMLElement} out @param {unknown} err @param {...string} more */
function sayError(out, err, ...more) {
  say(out, errorWords(err), ...more);
  out.classList.add("error");
}

/** @param {HTMLButtonElement} button @param {HTMLElement} out @param {() => Promise<void>} work */
async function act(button, out, work) {
  button.disabled = true;
  say(out, t("working"));
  try {
    await work();
  } catch (err) {
    sayError(out, err);
  } finally {
    button.disabled = false;
  }
}

/** @param {string} text @param {HTMLElement} target the element whose text is copied */
function copyButton(text, target) {
  const b = h("button", { type: "button", class: "copy", text: t("copy") });
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = t("copied");
    } catch {
      // No clipboard (an insecure origin, or refused): select it for the owner.
      const range = document.createRange();
      range.selectNodeContents(target);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      b.textContent = t("copyFailed");
    }
  });
  return b;
}

/** @param {string} code */
function codeBlock(code) {
  const c = h("code", { text: code });
  return h("div", { class: "code" }, h("pre", { tabindex: 0 }, c), copyButton(code, c));
}

/** @param {string} label @param {Record<string, unknown>} props */
function field(label, props, hint = "") {
  const id = nextId("f");
  const hintId = hint === "" ? undefined : nextId("h");
  return {
    wrap: h("div", { class: "field" },
      h("label", { for: id, text: label }),
      hint === "" ? null : h("p", { class: "hint", id: hintId, text: hint }),
      h("input", { id, "aria-describedby": hintId, ...props })),
    get input() {
      return /** @type {HTMLInputElement} */ (document.getElementById(id));
    },
  };
}

/** @param {number | null | undefined} ms */
function when(ms) {
  if (ms === null || ms === undefined) return t("never");
  return new Date(ms).toLocaleString(state.lang === "zh" ? "zh-CN" : "en");
}

/** @param {number} n */
function num(n) {
  return n.toLocaleString(state.lang === "zh" ? "zh-CN" : "en");
}

/** @param {string} title @param {...unknown} kids */
function show(title, ...kids) {
  const heading = h("h2", { tabindex: -1, text: title });
  main.replaceChildren(h("div", {}, heading, ...kids));
  heading.focus();
}

function drawTools() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.title = t("pageTitle");
  const other = state.lang === "zh" ? "en" : "zh";
  const items = [
    h("button", { type: "button", lang: other === "zh" ? "zh-CN" : "en", onclick: () => switchLanguage(other), text: texts[other].languageName }),
  ];
  if (state.api !== undefined) items.push(h("button", { type: "button", onclick: lock, text: t("lock") }));
  tools.replaceChildren(...items);
}

/** @param {"en" | "zh"} lang */
function switchLanguage(lang) {
  state.lang = lang;
  render();
}

function lock() {
  state.api = undefined;
  state.issued = undefined;
  state.flash = undefined;
  state.notice = undefined;
  history.replaceState(null, "", "#/");
  render();
}

// ---------------------------------------------------------------- sign in

function loginView() {
  const secret = field(t("secretLabel"), { type: "password", autocomplete: "off", required: true, spellcheck: "false" }, t("secretHint"));
  const out = outBox();
  const button = h("button", { type: "submit", text: t("signIn") });
  const form = h("form", {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const api = makeApi({ secret: secret.input.value });
      act(/** @type {HTMLButtonElement} */ (button), out, async () => {
        try {
          await api.list();
        } catch (err) {
          const hint = err instanceof ApiError && err.status === 401 ? t("hint401") : err instanceof ApiError && err.status === 404 ? t("hint404") : "";
          sayError(out, err, ...(hint === "" ? [] : [hint]));
          return;
        }
        secret.input.value = "";
        state.api = api;
        render();
      });
    },
  }, secret.wrap, button);
  show(t("signInTitle"), h("p", { text: t("intro") }), form, out);
}

// ---------------------------------------------------------------- the list

async function listView() {
  const api = /** @type {ReturnType<typeof makeApi>} */ (state.api);
  const out = outBox();
  const table = h("div", { class: "scroll" });
  const refresh = h("button", { type: "button", text: t("refresh") });
  const load = () =>
    act(/** @type {HTMLButtonElement} */ (refresh), out, async () => {
      const rows = /** @type {{ memories: Record<string, any>[] }} */ (await api.list()).memories;
      table.replaceChildren(rows.length === 0 ? h("p", { text: t("noMemories") }) : memoryTable(rows));
      say(out);
    });
  refresh.addEventListener("click", load);
  const notice = state.notice;
  state.notice = undefined;
  show(t("memoriesTitle"), notice === undefined ? null : h("div", { class: "flash", role: "status" }, h("p", { text: notice })),
    table, h("p", {}, refresh), out, createSection(), importSection());
  await load();
}

/** @param {Record<string, any>[]} rows */
function memoryTable(rows) {
  const head = [t("colName"), t("colMemories"), t("colEvents"), t("colLastEvent"), t("colToken"), t("colCreated")]
    .map((text) => h("th", { scope: "col", text }));
  const body = rows.map((r) => {
    const name = h("th", { scope: "row" }, h("a", { href: memoryHash(r.name), text: r.name }));
    if (typeof r.error === "string") return h("tr", {}, name, h("td", { colspan: 5, class: "error", text: r.error }));
    return h("tr", {}, name,
      h("td", { class: "n", text: num(r.memories) }),
      h("td", { class: "n", text: num(r.events) }),
      h("td", { text: when(r.lastEventAt) }),
      h("td", { text: r.hasToken ? t("tokenSet") : t("tokenNotSet") }),
      h("td", { text: when(r.createdAt) }));
  });
  return h("table", {}, h("caption", { class: "sr", text: t("memoriesTitle") }), h("thead", {}, h("tr", {}, head)), h("tbody", {}, body));
}

function createSection() {
  const name = field(t("nameLabel"), { required: true, autocomplete: "off", autocapitalize: "none", spellcheck: "false" }, t("nameHint"));
  const out = outBox();
  const button = h("button", { type: "submit", text: t("create") });
  const form = h("form", {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      act(/** @type {HTMLButtonElement} */ (button), out, async () => {
        const n = name.input.value.trim();
        const r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).create(n);
        state.issued = { name: r.memory, token: r.token };
        go(memoryHash(r.memory));
      });
    },
  }, name.wrap, button);
  return h("section", {}, h("h3", { text: t("createTitle") }), form, out);
}

function importSection() {
  const name = field(t("nameLabel"), { required: true, autocomplete: "off", autocapitalize: "none", spellcheck: "false" }, t("nameHint"));
  const file = field(t("fileLabel"), { type: "file", required: true, accept: ".ziwo-export" });
  const pass = field(t("passLabel"), { type: "password", required: true, autocomplete: "off" });
  const out = outBox();
  const button = h("button", { type: "submit", text: t("import") });
  const form = h("form", {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      act(/** @type {HTMLButtonElement} */ (button), out, async () => {
        const f = file.input.files?.[0];
        if (f === undefined) return;
        const n = name.input.value.trim();
        say(out, t("opening"));
        const clear = await open(new Uint8Array(await f.arrayBuffer()), pass.input.value);
        say(out, t("sending"));
        let r;
        try {
          r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).importClear(n, clear);
        } finally {
          clear.fill(0); // the export in the clear lives no longer than the call
        }
        pass.input.value = "";
        const lines = [t("imported", { memories: num(r.memories), events: num(r.events), at: when(r.exportedAt) })];
        if (typeof r.token === "string") state.issued = { name: r.memory, token: r.token };
        else lines.push(t("importKeptToken"));
        state.flash = { name: r.memory, lines };
        go(memoryHash(r.memory));
      });
    },
  }, h("p", { text: t("importIntro") }), name.wrap, file.wrap, pass.wrap, button);
  return h("section", {}, h("h3", { text: t("importTitle") }), form, out);
}

// ---------------------------------------------------------------- one memory

/** @param {string} name */
async function memoryView(name) {
  const api = /** @type {ReturnType<typeof makeApi>} */ (state.api);
  const back = h("p", {}, h("a", { href: "#/", text: t("back") }));
  const out = outBox();
  show(name, back, out);
  say(out, t("working"));
  let m;
  try {
    m = await api.describe(name);
  } catch (err) {
    sayError(out, err);
    return;
  }
  const address = location.origin + m.endpoint;
  const issued = state.issued?.name === name ? state.issued.token : undefined;
  const flash = state.flash?.name === name ? state.flash.lines : [];
  show(name, back,
    flash.length === 0 ? null : h("div", { class: "flash", role: "status" }, flash.map((l) => h("p", { text: l }))),
    issued === undefined ? null : tokenBox(name, issued),
    figures(m, address),
    connectSection(address, issued),
    grantsSection(name),
    tokenSection(name),
    settingsSection(name, m),
    checkSection(name),
    rebuildSection(name),
    exportSection(name),
    deleteSection(name));
}

/** @param {Record<string, any>} m @param {string} address */
function figures(m, address) {
  const addr = h("code", { text: address });
  const rows = [
    [t("address"), h("span", { class: "addr" }, addr, copyButton(address, addr))],
    [t("colMemories"), num(m.memories)],
    [t("colEvents"), num(m.events)],
    [t("colLastEvent"), when(m.lastEventAt)],
    [t("colToken"), m.hasToken ? t("tokenSet") : t("tokenNotSet")],
    [t("timeZone"), m.timeZone],
  ];
  return h("dl", { class: "figures" }, rows.map(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]));
}

/** @param {string} name @param {string} token */
function tokenBox(name, token) {
  const code = h("code", { text: token });
  const done = h("button", {
    type: "button",
    text: t("tokenSaved"),
    onclick: () => {
      state.issued = undefined;
      render();
    },
  });
  return h("section", { class: "token", "aria-labelledby": "token-title" },
    h("h3", { id: "token-title", text: t("tokenTitle", { name }) }),
    h("div", { class: "code" }, h("pre", { tabindex: 0 }, code), copyButton(token, code)),
    h("p", { class: "warn", text: t("tokenOnce") }),
    h("p", {}, done));
}

/** @param {{ text: string, code?: string }[]} steps */
function stepList(steps) {
  return h("ol", {}, steps.map((s) => h("li", {}, h("p", { text: s.text }), s.code === undefined ? null : codeBlock(s.code))));
}

/** @param {string} address @param {string | undefined} token */
function connectSection(address, token) {
  const guide = connectGuide(t, { address, token });
  return h("section", {},
    h("h3", { text: t("connectTitle") }),
    h("p", { text: t("connectIntro") }),
    h("p", { text: token === undefined ? t("connectNoToken", { placeholder: t("tokenPlaceholder") }) : t("connectWithToken") }),
    guide.map((c) =>
      h("details", {}, h("summary", { text: c.title }),
        h("h4", { text: t("guideSignIn") }), stepList(c.oauth),
        h("h4", { text: t("guideToken") }), stepList(c.token),
        c.either.length === 0 ? null : [h("h4", { text: t("guideEither") }), stepList(c.either)])));
}

// The clients granted access through sign-in, each with a way to revoke it.
/** @param {string} name */
function grantsSection(name) {
  const api = /** @type {ReturnType<typeof makeApi>} */ (state.api);
  const out = outBox();
  const list = h("div", { class: "scroll" });
  const refresh = /** @type {HTMLButtonElement} */ (h("button", { type: "button", text: t("refresh") }));
  const fill = async () => {
    const grants = /** @type {{ grants: { id: string, client: string, createdAt: number, expiresAt: number | null }[] }} */ (await api.grants(name)).grants;
    if (grants.length === 0) return list.replaceChildren(h("p", { text: t("grantsNone") }));
    const head = [t("colClient"), t("colApproved"), t("colLapses"), t("colGrant"), ""].map((text) => h("th", { scope: "col", text }));
    const rows = grants.map((g) => {
      const button = /** @type {HTMLButtonElement} */ (h("button", { type: "button", text: t("revoke") }));
      button.addEventListener("click", () => {
        if (!confirm(t("confirmRevoke", { client: g.client, name }))) return;
        act(button, out, async () => {
          await api.revokeGrant(name, g.id);
          await fill();
          say(out, t("revoked"));
        });
      });
      return h("tr", {}, h("th", { scope: "row", text: g.client }), h("td", { text: when(g.createdAt) }), // No expiry yet: approved, but the client has not fetched its tokens.
        h("td", { text: g.expiresAt === null ? t("grantPending") : when(g.expiresAt) }),
        h("td", {}, h("code", { text: g.id })), h("td", {}, button));
    });
    list.replaceChildren(h("table", {}, h("caption", { class: "sr", text: t("grantsTitle") }), h("thead", {}, h("tr", {}, head)), h("tbody", {}, rows)));
  };
  const load = () => act(refresh, out, async () => {
    await fill();
    say(out);
  });
  refresh.addEventListener("click", load);
  load();
  return h("section", {}, h("h3", { text: t("grantsTitle") }), h("p", { text: t("grantsIntro") }), h("p", { class: "warn", text: t("grantsRevokeWhen") }),
    list, h("p", { class: "hint", text: t("grantsLag") }), h("p", {}, refresh), out);
}

/** @param {string} name */
function tokenSection(name) {
  const out = outBox();
  const button = /** @type {HTMLButtonElement} */ (h("button", { type: "button", text: t("newToken") }));
  button.addEventListener("click", () => {
    if (!confirm(t("confirmToken", { name }))) return;
    act(button, out, async () => {
      const r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).newToken(name);
      state.issued = { name: r.memory, token: r.token };
      await render();
    });
  });
  return h("section", {}, h("h3", { text: t("tokenSectionTitle") }), h("p", { text: t("tokenIntro") }), h("p", { text: t("tokenGrantsNote") }), button, out);
}

/** @param {string} name @param {Record<string, any>} m */
function settingsSection(name, m) {
  const current = { params: { ...m.params }, timeZone: m.timeZone };
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zoneList = nextId("zones");
  const zone = field(t("timeZone"), { value: current.timeZone, list: zoneList, autocomplete: "off", spellcheck: "false" }, t("timeZoneHint"));
  const params = Object.fromEntries(paramNames.map((p) => [p,
    field(p, { value: String(current.params[p]), inputmode: "decimal", autocomplete: "off", spellcheck: "false" },
      `${t(`param-${p}`)} ${t("defaultIs", { value: String(/** @type {Record<string, number>} */ (defaultParams)[p]) })}`)]));
  const out = outBox();
  const button = h("button", { type: "submit", text: t("save") });
  const form = h("form", {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const c = settingsChange(current, {
        timeZone: zone.input.value,
        params: Object.fromEntries(paramNames.map((p) => [p, params[p].input.value])),
      });
      if ("notANumber" in c) return sayError(out, t("notANumber", { param: c.notANumber }));
      if ("unchanged" in c) return say(out, t("unchanged"));
      act(/** @type {HTMLButtonElement} */ (button), out, async () => {
        const r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).settings(name, c.change);
        current.params = { ...r.params };
        current.timeZone = r.timeZone;
        zone.input.value = r.timeZone;
        for (const p of paramNames) params[p].input.value = String(r.params[p]);
        say(out, t("saved"), ...(c.replays ? [t("replayed")] : []));
      });
    },
  },
  zone.wrap,
  h("datalist", { id: zoneList }, zones.map((z) => h("option", { value: z }))),
  h("fieldset", {}, h("legend", { text: t("paramsLegend") }), h("p", { class: "warn", text: t("replayWarning") }), paramNames.map((p) => params[p].wrap)),
  button);
  return h("section", {}, h("h3", { text: t("settingsTitle") }), form, out);
}

/** @param {string} name */
function checkSection(name) {
  const out = outBox();
  const button = /** @type {HTMLButtonElement} */ (h("button", { type: "button", text: t("runCheck") }));
  button.addEventListener("click", () =>
    act(button, out, async () => {
      const r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).check(name);
      const figs = h("table", {}, h("caption", { text: t("checkFigures") }),
        h("tbody", {}, r.figures.map((/** @type {{name: string, value: string}} */ f) =>
          h("tr", {}, h("th", { scope: "row", text: f.name }), h("td", { text: f.value })))));
      const groups = reportGroups(r).map((g) =>
        h("div", {}, h("h4", { text: levelTitle(g.level, g.findings.length) }),
          g.findings.length === 0
            ? h("p", { text: t("none") })
            : h("ul", {}, g.findings.map((f) => h("li", {}, h("code", { text: `[${f.code}]` }), ` ${f.text}`, f.ids.length > 0 ? `: ${f.ids.join(", ")}` : "")))));
      say(out, h("div", { class: "scroll" }, figs), ...groups);
    }));
  return h("section", {}, h("h3", { text: t("checkTitle") }), h("p", { text: t("checkIntro") }), button, out);
}

// A level the page has no words for is shown as the API names it.
/** @param {string} level @param {number} n */
function levelTitle(level, n) {
  const words = texts[state.lang][`level-${level}`];
  return words === undefined ? `${level} (${n})` : format(words, { n });
}

/** @param {string} name */
function rebuildSection(name) {
  const out = outBox();
  const button = /** @type {HTMLButtonElement} */ (h("button", { type: "button", text: t("rebuild") }));
  button.addEventListener("click", () =>
    act(button, out, async () => {
      const r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).rebuild(name);
      say(out, t("rebuilt", { memories: num(r.memories), events: num(r.events) }));
    }));
  return h("section", {}, h("h3", { text: t("rebuildTitle") }), h("p", { text: t("rebuildIntro") }), button, out);
}

/** @param {string} name */
function exportSection(name) {
  const pass = field(t("passLabel"), { type: "password", required: true, autocomplete: "new-password" }, t("passHint", { min: minPassphrase }));
  const again = field(t("passAgainLabel"), { type: "password", required: true, autocomplete: "new-password" });
  const out = outBox();
  const button = h("button", { type: "submit", text: t("export") });
  const form = h("form", {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const p = pass.input.value;
      if (p !== again.input.value) return sayError(out, t("passMismatch"));
      // Refused before fetching, in the words seal would use.
      if (new TextEncoder().encode(p).length < minPassphrase) {
        return sayError(out, new SealError("short-passphrase", `the passphrase must be at least ${minPassphrase} characters`));
      }
      act(/** @type {HTMLButtonElement} */ (button), out, async () => {
        const got = await /** @type {ReturnType<typeof makeApi>} */ (state.api).exportClear(name);
        say(out, t("sealing"));
        let sealed;
        try {
          sealed = await seal(got.bytes, p);
        } finally {
          got.bytes.fill(0); // the export in the clear lives no longer than the sealing
        }
        pass.input.value = "";
        again.input.value = "";
        const file = sealedFileName(got.disposition, name, Date.now());
        const url = URL.createObjectURL(new Blob([sealed], { type: "application/octet-stream" }));
        const link = h("a", { href: url, download: file, text: t("saveAgain", { file }) });
        say(out, t("exported", { file, bytes: num(sealed.length) }), h("p", {}, link), t("exportKeep"));
        /** @type {HTMLAnchorElement} */ (link).click();
        setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
      });
    },
  }, h("p", { text: t("exportIntro") }), pass.wrap, again.wrap, button);
  return h("section", {}, h("h3", { id: "export-title", tabindex: -1, text: t("exportTitle") }), form, out);
}

// Deleting asks for the name typed out, says that an export is the only way
// back, and offers the export first. The API wants the name repeated too.
/** @param {string} name */
function deleteSection(name) {
  const typed = field(t("deleteNameLabel", { name }), { required: true, autocomplete: "off", autocapitalize: "none", spellcheck: "false" }, t("deleteNameHint"));
  const out = outBox();
  const toExport = h("button", {
    type: "button",
    text: t("deleteExportFirst"),
    onclick: () => {
      const title = document.getElementById("export-title");
      title?.scrollIntoView({ block: "start" });
      title?.focus();
    },
  });
  const button = h("button", { type: "submit", text: t("deleteButton") });
  const form = h("form", {
    onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const value = typed.input.value;
      if (!namesMatch(value, name)) return sayError(out, t("deleteMismatch", { name }));
      act(/** @type {HTMLButtonElement} */ (button), out, async () => {
        const r = await /** @type {ReturnType<typeof makeApi>} */ (state.api).deleteMemory(name, value.trim());
        state.issued = undefined;
        state.flash = undefined;
        state.notice = t("deleted", { name, grants: num(r.revokedGrants) });
        go("#/");
      });
    },
  }, typed.wrap, button);
  return h("section", {}, h("h3", { text: t("deleteTitle") }), h("p", { text: t("deleteIntro") }),
    h("p", { class: "warn", text: t("deleteNoWayBack") }), h("p", {}, toExport), form, out);
}

// ---------------------------------------------------------------- routing

async function render() {
  drawTools();
  if (state.api === undefined) return loginView();
  const r = route(location.hash);
  if (r.view === "memory") return memoryView(r.name);
  return listView();
}

// go moves to another view. A token just issued, and what an import
// reported, are shown on their memory's view only, and gone once it is left.
/** @param {string} hash */
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

addEventListener("hashchange", () => {
  const r = route(location.hash);
  const here = r.view === "memory" ? r.name : undefined;
  if (state.issued !== undefined && state.issued.name !== here) state.issued = undefined;
  if (state.flash !== undefined && state.flash.name !== here) state.flash = undefined;
  render();
});

render();
