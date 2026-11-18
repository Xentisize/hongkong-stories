#!/usr/bin/env bun
/**
 * Measure how native the Cantonese sounds, before and after a prompt change.
 *
 * Prompt engineering that is not measured is just editing: this asks the live API the same eight
 * things — questions that make a character *explain* themselves, which is exactly where written
 * Chinese creeps into a spoken line — and scores each reply for Mandarin-flavoured words against
 * Cantonese ones.
 *
 * The scorer is a rough instrument, not a verdict. It counts words that only exist in Mandarin
 * (`很`, `甚麼`, `沒有`, `他`) against words that only exist in Cantonese (`嘅`, `咗`, `冇`, `佢`), and
 * leaves the `冇`/`唔` exceptions alone. Read the lines: the counts point, they do not decide.
 *
 * Requires a running API with OPENROUTER_API_KEY set.
 *
 * Usage: bun tools/measure_cantonese.ts [porthttp://127.0.0.1:3000]
 */

const API = Bun.argv[2] ?? process.env["HKS_API"] ?? "http://127.0.0.1:3000";

/**
 * Situations, not greetings.
 *
 * Two families, because they fail differently: a character *explaining* something slides toward
 * written Chinese, and a player writing in Mandarin or English makes the character *drift* into the
 * language of the question. A greeting tests neither.
 */
const PROMPTS: Array<{ npc: string; input: string; why: string }> = [
  { npc: "npc_ch01_ken", input: "根叔，你做咩唔搬去新界？間舖咁細。", why: "justifying a life choice" },
  { npc: "npc_ch01_ken", input: "你講下以前條街係點嘅？", why: "recounting the past" },
  { npc: "npc_ch01_ken", input: "如果間舖冇人要，你會點算？", why: "hypothetical, conditional" },
  { npc: "npc_ch01_ming", input: "阿明，你將來想做咩？", why: "plans, abstract nouns" },
  { npc: "npc_ch01_ming", input: "你係咪唔開心呀？", why: "naming an emotion" },
  { npc: "npc_ch01_ming", input: "你鍾唔鍾意呢個地方？", why: "opinion, comparison" },
  { npc: "npc_ch01_wai", input: "阿威，你點解成日坐喺度？", why: "explaining a habit" },
  { npc: "npc_ch01_wai", input: "你覺得我阿媽個人點？", why: "judging someone" },
  { npc: "npc_ch01_ken", input: "呢條街以前同而家最大分別係咩？", why: "stating lore — written register creeps in" },
  { npc: "npc_ch01_wai", input: "你覺得做人最緊要係咩？", why: "abstraction" },
  { npc: "npc_ch01_ken", input: "你为什么不去新界住？", why: "DRIFT: player wrote Mandarin" },
  { npc: "npc_ch01_ming", input: "Why don't you leave this street?", why: "DRIFT: player wrote English" },
];

/** Words a Cantonese speaker does not use as function words. */
const MANDARIN = [
  "很", "甚麼", "什么", "誰", "谁", "這", "这", "他", "她", "們", "们", "沒有", "没有", "但是", "現在", "现在",
];
/**
 * Written-Chinese vocabulary and Mandarin grammar: what a line sounds like when a character starts
 * *composing sentences* instead of talking. None of these are words a Hong Kong speaker says.
 */
const WRITTEN = [
  "否則", "然而", "因此", "故此", "由於", "關於", "於是", "假如", "倘若", "以及", "並且", "之一",
  "總而言之", "給", "讓", "與",
];
/** Words a Cantonese speaker does use, and which a Mandarin line would not carry. */
const CANTONESE = [
  "嘅", "咗", "啲", "佢", "喺", "冇", "咩", "嗰", "哋", "唔", "係", "睇", "搵", "攞", "而家", "得閒", "唔該",
  "餸", "好", "啦", "喇", "囉", "喎", "咋", "嘛", "㗎",
];

function hits(line: string, words: string[]): string[] {
  return words.filter((word) => line.includes(word));
}

interface Reply {
  say: string;
  why: string;
}

async function session(): Promise<string> {
  const response = await fetch(`${API}/v1/session`, { method: "POST" });
  if (!response.ok) throw new Error(`session failed: ${response.status}`);
  const body = (await response.json()) as { session_token?: string };
  if (!body.session_token) throw new Error("session returned no token");
  return body.session_token;
}

async function ask(token: string, npc: string, input: string): Promise<string> {
  const response = await fetch(`${API}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_token: token,
      npc_id: npc,
      lang: "zh_HK",
      input,
      state: {},
    }),
  });
  if (!response.ok) throw new Error(`chat failed: ${response.status} ${await response.text()}`);

  // The stream ends with the whole line assembled; reading it means not re-implementing the parser.
  const text = await response.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      const event = JSON.parse(trimmed.slice(5).trim()) as { type?: string; say?: string };
      if (event.type === "done" && typeof event.say === "string") return event.say;
    } catch {
      // not a JSON event (a keepalive, or a partial line)
    }
  }
  throw new Error(`no done event in stream: ${text.slice(0, 200)}`);
}

const token = await session();
const replies: Reply[] = [];

for (const prompt of PROMPTS) {
  try {
    replies.push({ say: await ask(token, prompt.npc, prompt.input), why: prompt.why });
  } catch (error) {
    console.error(`${prompt.npc} — ${prompt.why}: ${String(error)}`);
  }
}

let mandarinTotal = 0;
let writtenTotal = 0;
let cantoneseTotal = 0;

console.log(`\n${replies.length} replies from ${API}\n`);
replies.forEach((reply, index) => {
  const bad = hits(reply.say, MANDARIN);
  const written = hits(reply.say, WRITTEN);
  const good = hits(reply.say, CANTONESE);
  mandarinTotal += bad.length;
  writtenTotal += written.length;
  cantoneseTotal += good.length;
  console.log(`${index + 1}. [${reply.why}]`);
  console.log(`   ${reply.say}`);
  console.log(
    `   native ${good.length}${good.length > 0 ? ` (${good.join(" ")})` : ""}` +
      ` · mandarin ${bad.length}${bad.length > 0 ? ` (${bad.join(" ")})` : ""}` +
      ` · written ${written.length}${written.length > 0 ? ` (${written.join(" ")})` : ""}\n`,
  );
});

console.log(`TOTAL native=${cantoneseTotal} mandarin=${mandarinTotal} written=${writtenTotal} over ${replies.length} lines`);
console.log(
  `per line: native=${(cantoneseTotal / replies.length).toFixed(1)}` +
    ` mandarin=${(mandarinTotal / replies.length).toFixed(1)}` +
    ` written=${(writtenTotal / replies.length).toFixed(1)}`,
);
