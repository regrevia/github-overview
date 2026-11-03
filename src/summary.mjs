import { readConfig, writeConfig } from "./config.mjs";

const DEFAULT_MODEL = "deepseek-chat";

export function templateSummary(ctx) {
  const { uniques, external, stars, npmWeek, days, covered } = ctx;
  const lines = [];
  // GitHub 只留 14 天，范围比历史长时说明覆盖了几天，不把 14 天的数说成 30 天
  if (uniques == null) lines.push(`还没有访问记录。`);
  else if (uniques === 0) lines.push(`这段时间还没有访客。`);
  else lines.push(`约 ${uniques} 人来看过仓库。`);
  const ic = external.issues.length, pc = external.pulls.length;
  lines.push(ic || pc ? `外部提了 ${ic} 个 issue、${pc} 个 PR。` : `这段时间没有外部 issue 或 PR。`);
  if (stars) lines.push(`Star 到 ${stars}${npmWeek ? `，npm 周下载 ${fmt(npmWeek)}` : ""}。`);
  return lines;
}

const fmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(2).replace(/0$/, "")} 万` : String(n));

// AI 配置就两样：apikey 和 baseurl，存在本机配置里，不进仓库
export function readAiConfig() {
  const cfg = readConfig();
  return { apikey: cfg.apikey || "", baseurl: cfg.baseurl || "", model: cfg.model || DEFAULT_MODEL };
}

export function saveAiConfig({ apikey, baseurl, model }) {
  const cfg = readConfig();
  return writeConfig({ ...cfg, apikey: apikey ?? cfg.apikey ?? "", baseurl: baseurl ?? cfg.baseurl ?? "", model: model || cfg.model || DEFAULT_MODEL });
}

const factLines = (ctx) =>
  [
    `范围：${ctx.scope || "本仓库"}，近 ${ctx.days} 天${ctx.covered && ctx.covered < ctx.days ? `（数据覆盖 ${ctx.covered} 天）` : ""}`,
    `访客（去重真人）：${ctx.uniques ?? "未知"} 人，浏览 ${ctx.views ?? "未知"} 次`,
    ...(ctx.topRepos ? [`全站 ${ctx.allTotal ?? "未知"} 人；最热：${ctx.topRepos.map((r) => `${r.name}（${r.u}）`).join("、")}`] : []),
    `外部 issue ${ctx.external.issues.length} 个，外部 PR ${ctx.external.pulls.length} 个`,
    `stars ${ctx.stars}，npm 周下载 ${ctx.npmWeek ?? "未关联 npm"}`,
    `最热页面：${(ctx.paths || []).slice(0, 3).map((p) => `${p.p}（${p.n}）`).join("、") || "暂无"}`,
  ].join("\n");

const ENDPOINT = (baseurl) => baseurl.replace(/\/$/, "") + "/chat/completions";

export async function askQuestion(ctx, question) {
  const { apikey, baseurl, model } = readAiConfig();
  if (!apikey || !baseurl) return { source: "none", answer: "先在配置里填 Base URL 和 API Key。" };
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content:
          "你在回答一个 GitHub 仓库数据看板上的提问。只依据给出的数字回答，1 到 2 句，合计不超过 60 个汉字。" +
          "访客数就是去重后的真人访客，问多少人时直接用这个数。" +
          "单仓面板下问跨仓或最热门，用“全站”那一行。" +
          "数字里没有的说没记录。不要解释变化原因，不要提机器人、CI、镜像。直接输出答案。",
      },
      { role: "user", content: `${factLines(ctx)}\n\n问题：${question}` },
    ],
  };
  try {
    const res = await fetch(ENDPOINT(baseurl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apikey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { source: "error", answer: `AI 没回应（${res.status}）` };
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return { source: "error", answer: "AI 回了空内容。" };
    return { source: "ai", answer: text.replace(/\s+/g, " ").slice(0, 160) };
  } catch (e) {
    return { source: "error", answer: "连不上 Base URL。" };
  }
}

export async function aiSummary(ctx) {
  const { apikey, baseurl, model } = readAiConfig();
  if (!apikey || !baseurl) return { source: "template", lines: templateSummary(ctx) };
  const url = ENDPOINT(baseurl);
  const facts = factLines(ctx);
  const body = {
    model,
    temperature: 0.3,
    max_tokens: 180,
    messages: [
      {
        role: "system",
        content:
          "你在给一个 GitHub 仓库的数据看板写摘要。只写 2 到 3 句话，每句不超过 26 个汉字。" +
          "只讲结论和事实：大概多少人来看、外部给了什么反馈、仓库涨了多少。" +
          "不要解释流量为什么涨，不要提机器、机器人、镜像、CI、发版带来的流量，不要用「图 1」这种编号引用。" +
          "不要重复用户已经看到的数字之外的分析；不要用「独立」「重复」这类词。直接输出正文，不要列表，不要标题。",
      },
      { role: "user", content: facts },
    ],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apikey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty");
    const lines = text.split(/\n+/).map((s) => s.replace(/^[-*\d.、\s]+/, "").trim()).filter(Boolean).slice(0, 3);
    return { source: "ai", lines, model };
  } catch (e) {
    return { source: "template", lines: templateSummary(ctx), error: String(e.message || e) };
  }
}
