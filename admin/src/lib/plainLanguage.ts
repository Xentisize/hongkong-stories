/* Validation, in the author's language.
 *
 * The validator speaks in paths and schema words (`locations/x.legend/q`, `rect escapes the map`),
 * which is what a machine needs and not what a hobbyist needs. This maps the messages we actually
 * emit onto a sentence about *the game* — what the player would see, and what to do about it — and
 * falls back to the original text when it has nothing better, because inventing a friendly sentence
 * for a message we do not understand would be worse than quoting it.
 */

export interface Issue {
  level: string;
  path: string;
  message: string;
}

export interface PlainIssue extends Issue {
  /** One sentence about the game, not the schema. */
  plain: string;
  /** What the author can do next, when we know. */
  hint?: string;
}

interface Rule {
  match: RegExp;
  plain: (issue: Issue) => string;
  hint?: string;
}

/** The messages this build emits, in the order someone is likely to meet them. */
export const RULES: Rule[] = [
  {
    match: /is not in legend/i,
    plain: (issue) => `地圖上有一個字（${/(['"])(.*?)\1/.exec(issue.message)?.[2] ?? "?"}）未有對應圖塊，嗰格會畫唔出。/ a map cell uses a character that has no tile.`,
    hint: "喺調色盤揀過另一個字，或者幫 legend 加返呢個字 / paint the cell with a known character",
  },
  {
    match: /rect escapes the map|outside the .{0,12}map/i,
    plain: () => "有一道門或者一個障礙伸到地圖出面。/ a door or a blocker reaches past the edge of the map.",
    hint: "將個框拉返入地圖範圍 / pull the rectangle back inside the map",
  },
  {
    match: /unknown transform/i,
    plain: () => "有個圖塊用咗一個唔存在嘅翻轉方式。/ a tile asks for a rotation the game does not know.",
    hint: "改用 rot90 / rot180 / rot270 / flipX / flipY / flipXY",
  },
  {
    match: /a frame is \[col, row\]/i,
    plain: () => "有個圖塊嘅座標寫錯咗。/ one tile's atlas coordinates are malformed.",
    hint: "格式係 [col, row] 或 [col, row, transform]",
  },
  {
    match: /whole number/i,
    plain: () => "圖塊座標有小數，圖集冇半格。/ a tile coordinate is a fraction, and the atlas has no half cells.",
    hint: "改返整數 column 同 row",
  },
  {
    match: /title|missing|required|must have/i,
    plain: (issue) => `《${issue.path.split(".")[0] ?? issue.path}》少咗必要內容。/ a document is missing something it must have.`,
    hint: "補返標題或必填欄位 / fill in the missing field",
  },
  {
    match: /is read by a condition but nothing can set it/i,
    plain: (issue) => {
      const flag = /'([^']+)'/.exec(issue.message)?.[1] ?? "?";
      return `「${flag}」呢個旗標有人等緊，但遊戲永遠唔會設定佢，所以嗰步會卡住。/ the flag "${flag}" is waited on but nothing ever sets it, so that step can never happen.`;
    },
    hint: "加一個會設定呢個旗標嘅效果，或者改走個條件 / add an effect that sets it, or stop waiting on it",
  },
  {
    match: /unknown art style|unknown art medium/i,
    plain: () => "美術外觀揀咗一個呢個版本唔識嘅選項。/ the chosen art look is not one this build knows.",
    hint: "去「設定 Settings」再揀一次 / pick it again in Settings",
  },
  {
    match: /must be named 'game'/i,
    plain: () => "設定檔名唔啱，遊戲只會讀 settings/game。/ the settings document must be called game.",
  },
  {
    match: /credits/i,
    plain: () => "鳴謝清單格式唔啱。/ the credits block is not a list it can render.",
    hint: "每個鳴謝要有角色同至少一個名字 / each credit needs a role and a name",
  },
];

/** Translate one issue; unknown messages are quoted rather than dressed up. */
export function explainIssue(issue: Issue): PlainIssue {
  for (const rule of RULES) {
    if (rule.match.test(issue.message)) {
      return { ...issue, plain: rule.plain(issue), hint: rule.hint };
    }
  }
  return { ...issue, plain: issue.message };
}

/** Errors first, then warnings — the order in which they block shipping. */
export function explainIssues(issues: Issue[]): PlainIssue[] {
  const rank = (level: string) => (level === "error" ? 0 : level === "warn" || level === "warning" ? 1 : 2);
  return [...issues].map(explainIssue).sort((a, b) => rank(a.level) - rank(b.level));
}

/** What the checklist says at the top: can this ship, and how much is waiting. */
export function shipVerdict(issues: Issue[], pending: number): { ok: boolean; line: string } {
  const errors = issues.filter((issue) => issue.level === "error").length;
  if (errors > 0) {
    return { ok: false, line: `有 ${errors} 樣嘢要修好先出貨 / ${errors} thing(s) must be fixed before shipping` };
  }
  if (pending === 0) {
    return { ok: true, line: "冇待發佈嘅改動 / nothing waiting to ship" };
  }
  return { ok: true, line: `${pending} 樣改動準備好 / ${pending} change(s) ready to ship` };
}
