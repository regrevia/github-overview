import { readConfig, writeConfig } from "./config.mjs";

const DEFAULT_MODEL = "deepseek-chat";

export function templateSummary(ctx) {
  const { uniques, views, external, stars, npmWeek, days, covered, day } = ctx;
  const lines = [];
  // GitHub 只留 14 天，范围比历史长时说明覆盖了几天，不把 14 天的数说成 30 天
  const n = (x) => Number(x).toLocaleString("en-US");
  if (views == null && uniques == null) lines.push(`还没有访问记录。`);
  else if (days === 1 && day) lines.push(`${String(day).slice(5)} 浏览 ${n(views ?? 0)}、访客 ${n(uniques ?? 0)}。`);
  else if (!uniques && !views) lines.push(`这段时间还没有访客。`);
  else { const span = Math.min(days, covered || days); const ud = Math.min(covered || 14, 14); lines.push(`${span} 天 ${n(views)} 次浏览${uniques ? `、访客 ${n(uniques)}（${ud} 天去重）` : ""}。`); }
  const ic = external.issues.length, pc = external.pulls.length;
  lines.push(ic || pc ? `外部提了 ${ic} 个 issue、${pc} 个 PR。` : `这段时间没有外部 issue 或 PR。`);
  if (stars) lines.push(`Star 共 ${stars}${npmWeek ? `，npm 周下载 ${fmt(npmWeek)}` : ""}。`);
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

const mmdd = (t) => (t ? String(t).slice(5, 10) : "");
const detailLines = (external) => {
  const rows = [
    ...(external.pulls || []).slice(0, 4).map((p) => `PR #${p.number} ${p.author} ${p.merged ? "已合并" : p.state} ${p.comments ?? 0} 回`),
    ...(external.issues || []).map((i) => `issue #${i.number} ${i.author} ${i.state} ${i.comments ?? 0} 回${i.state === "open" && !i.comments ? "（没回）" : ""}`),
  ];
  return rows.length ? [`外部明细：${rows.join("；")}`] : [];
};

const factLines = (ctx) =>
  [
    `范围：${ctx.scope || "本仓库"}。issue/PR/发版按近 ${ctx.days} 天`,
    `访客是近 ${Math.min(ctx.covered || 14, 14)} 天的去重人数（GitHub 只给这个长度）：${ctx.uniques ?? "未知"} 人`,
    `所选 ${ctx.days} 天范围内浏览 ${ctx.views ?? "未知"} 次；浏览比访客多，因为同一个人可以看多次`,
    `这两段的时间长度不同，写的时候分开说，不要合并成同一个「近 N 天」`,
    ...(ctx.topRepos ? [`全站 ${ctx.allTotal ?? "未知"} 人；最热：${ctx.topRepos.map((r) => `${r.name}（${r.u}）`).join("、")}`] : []),
    `外部 issue ${ctx.external.issues.length} 个，外部 PR ${ctx.external.pulls.length} 个`,
    ...detailLines(ctx.external),
    ...(ctx.funnel ? [`漏斗：浏览 ${ctx.funnel.views ?? "—"} → 仓库主页 ${ctx.funnel.home ?? "—"} → npm 下载 ${ctx.funnel.npm ?? "—"}`] : []),
    ...(ctx.impacts?.length ? [`各仓最近发版日均浏览：${ctx.impacts.slice(0, 6).map((i) => `${i.name} ${i.before?.views?.avg ?? "—"}→${i.after?.views?.avg ?? "—"}`).join("、")}`] : []),
    ...(ctx.impact ? [`最近发版 ${ctx.impact.version}（${mmdd(ctx.impact.at)}）：前 7 天日均浏览 ${ctx.impact.before.views?.avg ?? "—"}、下载 ${ctx.impact.before.npm?.avg ?? "—"}，后 7 天 ${ctx.impact.after.views?.avg ?? "—"}、${ctx.impact.after.npm?.avg ?? "—"}`] : []),
    `stars 合计 ${ctx.stars}（总数，不是新增），npm 周下载 ${ctx.npmWeek ?? "未关联 npm"}`,
    `最热页面：${(ctx.paths || []).slice(0, 3).map((p) => `${p.p}（${p.n}）`).join("、") || "暂无"}`,
  ].join("\n");

const ENDPOINT = (baseurl) => baseurl.replace(/\/$/, "") + "/chat/completions";

export async function askQuestion(ctx, question, tools = []) {
  const { apikey, baseurl, model } = readAiConfig();
  if (!apikey || !baseurl) return { source: "none", answer: "先在配置里填 Base URL 和 API Key。" };
  const url = ENDPOINT(baseurl);
  const messages = [
    {
      role: "system",
      content:
        "你是这个 GitHub 数据看板的助手。下面给了当前范围已有的数据，需要更多的就用工具查，然后再回答。" +
        "说清楚数字和结论，可以分析、比较、估算，估算要说明依据。" +
        "数据里没有的直说没有，不要编造。回答用纯文本，不用 markdown，控制在 3 句以内。" +
        "访客数口径是去重真人，克隆另算，机器人流量和发布峰值已经排除在外部反馈之外。",
    },
    { role: "user", content: `${factLines(ctx)}\n\n问题：${question}` },
  ];
  const toolDefs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } } }));
  const runTool = async (name, args) => {
    const t = tools.find((x) => x.name === name);
    if (!t) return "没有这个工具";
    try {
      const out = await t.run(args || {});
      return typeof out === "string" ? out : JSON.stringify(out ?? null).slice(0, 900);
    } catch (e) {
      return "工具出错：" + String(e.message || e).slice(0, 120);
    }
  };
  const call = async (msgs, withTools) => {
    const body = { model, temperature: 0.2, max_tokens: 1400, messages: msgs, ...(withTools && toolDefs.length ? { tools: toolDefs } : {}) };
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apikey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(28000) });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json())?.choices?.[0]?.message;
  };
  try {
    let msg;
    try {
      msg = await call(messages, true);
    } catch {
      msg = await call(messages, false);
    }
    for (let i = 0; i < 2 && msg?.tool_calls?.length; i++) {
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const c of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(c.function?.arguments || "{}");
        } catch (e) {}
        messages.push({ role: "tool", tool_call_id: c.id, content: await runTool(c.function?.name, args) });
      }
      msg = await call(messages, true);
    }
    let text = (msg?.content || "").trim();
    if (!text) {
      const again = await call(messages.concat([{ role: "user", content: "直接回答上面的问题，不要用工具。" }]), false).catch(() => null);
      text = (again?.content || "").trim();
    }
    if (!text) return { source: "error", answer: "AI 回了空内容。" };
    return { source: "ai", answer: text.replace(/\s+/g, " ").slice(0, 400) };
  } catch (e) {
    const slow = e?.name === "TimeoutError" || /abort|timeout/i.test(e?.message || "");
    return { source: "error", answer: slow ? "模型超时，再问一次。" : "模型没答，再问一次。" };
  }
}

export async function aiSummary(ctx) {
  const { apikey, baseurl, model } = readAiConfig();
  if (!apikey || !baseurl) return { source: "none", lines: templateSummary(ctx) };
  const url = ENDPOINT(baseurl);
  const facts = factLines(ctx);
  const body = {
    model,
    temperature: 0.3,
    max_tokens: 900,
    messages: [
      {
        role: "system",
        content:
          "你在给一个 GitHub 仓库的数据看板写摘要。只写 2 到 3 句话，每句不超过 26 个汉字。" +
          "只讲结论和事实：大概多少人来看、外部给了什么反馈、仓库涨了多少。" +
          "范围天数用给定数据里的那个数字，不要换成年、月或别的时间；数据覆盖天数少于范围天数时，两句之内要写明覆盖了多少天。" +
          "不要解释流量为什么涨，不要提机器、机器人、镜像、CI、发版带来的流量，不要用「图 1」这种编号引用。" +
          "不要重复用户已经看到的数字之外的分析；不要用「独立」「重复」这类词。直接输出正文，不要列表，不要标题。",
      },
      { role: "user", content: facts },
    ],
  };
  const send = async (payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apikey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  };
  try {
    let text = await send(body);
    if (!text) {
      text = await send({
        ...body,
        max_tokens: 1200,
        messages: [...body.messages, { role: "user", content: "用两句话总结上面这些数字，直接给正文。" }],
      });
    }
    if (!text) throw new Error("empty");
    const lines = text.split(/\n+/).map((s) => s.replace(/^[-*\d.、\s]+/, "").trim()).filter(Boolean).slice(0, 3);
    return { source: "ai", lines, model };
  } catch (e) {
    return { source: "template", lines: templateSummary(ctx), error: String(e.message || e) };
  }
}
