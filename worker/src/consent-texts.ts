// Every text of the consent page, in English and in Simplified Chinese. The
// two hold the same keys and the same {placeholders}; a test keeps them so.

export type Lang = "en" | "zh";

const en = {
  title: "ziwo: allow a client",
  languageName: "English",
  askTitle: "Which memory?",
  askIntro: "{client} asks to use a memory on this deployment, but did not say which one. Give the name that is in the address you gave it: the part just before /mcp.",
  askLabel: "Memory name",
  askHint: "1 to 32 lower-case letters, digits, - or _, starting with a letter or digit.",
  askBadName: "That is not a memory name.",
  continue: "Continue",
  heading: "Let {client} use the memory {memory}?",
  clientLabel: "Client",
  clientPublished: "Published by {domain}.",
  clientSelfNamed: "The client gave this name itself; it is not verified.",
  returnLabel: "Sends you back to",
  loopbackWarn: "This sends access to a program on this computer. Approve only if you just started connecting from a program here.",
  memoryLabel: "Memory",
  addressLabel: "Address",
  what: "If you approve, this client can read and change everything in this memory, and nothing else on this deployment, until the grant is revoked or goes unused for 30 days. Grants are listed, and can be revoked, on the admin page.",
  credLabel: "This memory's token, or the admin secret",
  credHint: "Approving needs one of the two. It is checked here and not kept, and the client never sees it.",
  approve: "Approve",
  deny: "Deny",
  refused: "Not accepted. Check what you typed and try again.",
  forged: "This approval was not sent from this page, so it was not accepted. Start again from the client.",
  invalid: "This request cannot go on. Start again from the client.",
  detail: "The server said: {detail}",
  cimd: "The client's description at {url} could not be fetched, or is not valid. Try again later.",
  unavailable: "This memory cannot be opened right now. Try again in a moment.",
  tooMany: "Too many attempts from here were not accepted. Wait {seconds} seconds, then go back to the form and try again.",
};

export type TextKey = keyof typeof en;

const zh: Record<TextKey, string> = {
  title: "ziwo:允许客户端访问",
  languageName: "中文",
  askTitle: "哪个记忆体?",
  askIntro: "{client} 请求使用这个部署上的一个记忆体,但没有说是哪一个。请填你给它的地址里的名字:紧挨在 /mcp 前面的那一段。",
  askLabel: "记忆体名字",
  askHint: "1 到 32 个小写字母、数字、- 或 _,以字母或数字开头。",
  askBadName: "这不是一个记忆体名字。",
  continue: "继续",
  heading: "允许 {client} 使用记忆体 {memory}?",
  clientLabel: "客户端",
  clientPublished: "由 {domain} 发布。",
  clientSelfNamed: "这个名字是客户端自己报的,未经验证。",
  returnLabel: "完成后跳转到",
  loopbackWarn: "访问权限会交给这台电脑上的一个程序。只有在你刚刚从这台电脑上的程序发起连接时才批准。",
  memoryLabel: "记忆体",
  addressLabel: "地址",
  what: "批准后,这个客户端可以读取和修改这个记忆体里的一切,但碰不到这个部署上的其他东西;直到这次授权被撤销,或连续 30 天没有使用。授权都列在管理页面上,也可以在那里撤销。",
  credLabel: "这个记忆体的令牌,或管理密钥",
  credHint: "批准需要两者之一。它只在这里核对,不会保存,客户端也看不到它。",
  approve: "批准",
  deny: "拒绝",
  refused: "未通过。请检查输入的内容后再试。",
  forged: "这次批准不是从这个页面发出的,所以没有被接受。请从客户端重新开始。",
  invalid: "这个请求无法继续。请从客户端重新开始。",
  detail: "服务器的说明:{detail}",
  cimd: "无法获取 {url} 上的客户端描述,或者它无效。请稍后再试。",
  unavailable: "这个记忆体现在打不开。请稍后再试。",
  tooMany: "从这里提交的未通过次数太多。请等 {seconds} 秒,再返回表单重试。",
};

export const consentTexts: Record<Lang, Record<TextKey, string>> = { en, zh };

// pickLang chooses the language: the page's own switch first, then the
// browser's languages in their order; English when neither says.
export function pickLang(chosen: string | null, acceptLanguage: string | null): Lang {
  if (chosen === "en" || chosen === "zh") return chosen;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0]!.trim().toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) return "zh";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}
