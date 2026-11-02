import { readConfig, writeConfig } from "./config.mjs";

const DEFAULT_MODEL = "deepseek-chat";

export function templateSummary(ctx) {
  const { uniques, external, stars, npmWeek, days } = ctx;
  const lines = [];
  if (uniques != null) lines.push(`近 ${days} 天约 ${uniques} 人来看过仓库。`);
  const ic = external.issues.length, pc = external.pulls.length;
  lines.push(ic || pc ? `外部提了 ${ic} 个 issue、${pc} 个 PR。` : `这段时间没有外部 issue 或 PR。`);
  if (stars != null) lines.push(`Star 到 ${stars}${npmWeek ? `，npm 周下载 ${fmt(npmWeek)}` : ""}。`);
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

export async function aiSummary(ctx) {
  const { apikey, baseurl, model } = readAiConfig();
  if (!apikey || !baseurl) return { source: "template", lines: templateSummary(ctx) };
  const url = baseurl.replace(/\/$/, "") + "/chat/completions";
  const facts = [
    `窗口：近 ${ctx.days} 天`,
    `访客：${ctx.uniques ?? "未知"} 人，浏览 ${ctx.views ?? "未知"} 次`,
    `外部 issue ${ctx.external.issues.length} 个，外部 PR ${ctx.external.pulls.length} 个`,
    `stars ${ctx.stars}，npm 周下载 ${ctx.npmWeek ?? "未知"}`,
    `最热页面：${(ctx.paths || []).slice(0, 3).map((p) => `${p.p}（${p.n}）`).join("、")}`,
  ].join("\n");
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
