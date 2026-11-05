import { readConfig, writeConfig } from "./config.mjs";

const DEFAULT_MODEL = "deepseek-chat";

export function templateSummary(ctx) {
  const { uniques, views, external, stars, npmWeek, days, covered, day } = ctx;
  const lines = [];
  // GitHub 只留 14 天，范围比历史长时说明覆盖了几天，不把 14 天的数说成 30 天
  const n = (x) => Number(x).toLocaleString("en-US");
  if (views == null && uniques == null) lines.push(`还没有访问记录。`);
  else if (days === 1 && day) lines.push(`${String(day).slice(5)} 浏览 ${n(views ?? 0)}${uniques ? `；访客 ${n(uniques)} 是近 ${Math.min(covered || 14, 14)} 天去重的人数` : ""}。`);
  else if (!uniques && !views) lines.push(`这段时间还没有访客。`);
  else {
    const span = ctx.span || Math.min(days, covered || days);
    const ud = Math.min(covered || 14, 14);
    // 访客是 GitHub 的 14 天去重值，窗口更短时要说明跨度不同，别和浏览并列
    lines.push(span >= ud
      ? `${span} 天 ${n(views)} 次浏览${uniques ? `、访客 ${n(uniques)}（${ud} 天去重）` : ""}。`
      : `${span} 天 ${n(views)} 次浏览${uniques ? `；访客 ${n(uniques)} 是近 ${ud} 天去重的人数` : ""}。`);
  }
  const ic = external.issues.length, pc = external.pulls.length;
  lines.push(ic || pc ? `外部提了 ${ic} 个 issue、${pc} 个 PR。` : `这段时间没有外部 issue 或 PR。`);
  const sg = ctx.starGrowth;
  // 「同期」读者没法对上跨度，直接写清楚是当天还是近几天
  // 一天窗口写实际日期，不写「当天」，否则和 KPI 上的日期对不上
  const sgTxt = sg && sg.delta != null
    ? (sg.span === 1 ? `${String(sg.to || "").slice(5)} +${sg.delta}` : `近 ${sg.span} 天 +${sg.delta}`)
    : "";
  if (stars) lines.push(`Star 共 ${stars}${sgTxt ? `（${sgTxt}）` : ""}${npmWeek ? `，npm 周下载 ${n(npmWeek)}` : ""}。`);
  return lines;
}

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
    `范围：${ctx.scope || "本仓库"}。issue/PR/发版按图上 ${ctx.span ?? ctx.days} 天`,
    `访客是近 ${Math.min(ctx.covered || 14, 14)} 天的去重人数（GitHub 只给这个长度）：${ctx.uniques ?? "未知"} 人`,
    `图上的区间是 ${ctx.span ?? ctx.days} 天，区间内浏览 ${ctx.views ?? "未知"} 次；浏览比访客多，因为同一个人可以看多次`,
    `这两段的时间长度不同，写的时候分开说，不要合并成同一个「近 N 天」`,
    ...(ctx.topRepos ? [`全站 ${ctx.allTotal ?? "未知"} 人；最热：${ctx.topRepos.map((r) => `${r.name}（${r.u}）`).join("、")}`] : []),
    `外部 issue ${ctx.external.issues.length} 个，外部 PR ${ctx.external.pulls.length} 个`,
    ...detailLines(ctx.external),
    ...(ctx.funnel ? [`漏斗：浏览 ${ctx.funnel.views ?? "—"} → 仓库主页 ${ctx.funnel.home ?? "—"} → npm 下载 ${ctx.funnel.npm ?? "—"}`] : []),
    ...(ctx.impacts?.length ? [`各仓最近发版日均浏览：${ctx.impacts.slice(0, 6).map((i) => `${i.name} ${i.before?.views?.avg ?? "—"}→${i.after?.views?.avg ?? "—"}`).join("、")}`] : []),
    ...(ctx.impact ? [`最近发版 ${ctx.impact.name ? ctx.impact.name + " " : ""}${ctx.impact.version}（${mmdd(ctx.impact.at)}）：前 7 天日均浏览 ${ctx.impact.before.views?.avg ?? "—"}、下载 ${ctx.impact.before.npm?.avg ?? "—"}，后 7 天 ${ctx.impact.after.views?.avg ?? "—"}、${ctx.impact.after.npm?.avg ?? "—"}`] : []),
    `stars 合计 ${ctx.stars}（当前总数），近 ${ctx.starGrowth?.span ?? ctx.days} 天新增 ${ctx.starGrowth?.delta ?? "—"}，总数和新增要分开说，新增要带上这几天`,
    `npm 周下载 ${ctx.npmWeek ?? "未关联 npm"}`,
    `最热页面：${(ctx.paths || []).slice(0, 3).map((p) => `${p.p}（${p.n}）`).join("、") || "暂无"}`,
  ].join("\n");

// AI 摘要只允许引用给定事实里的数字：对不上就退回模板，免得出现「个仓库」「约 1.2 万」这种错数
const near = (d, a) => typeof a === "number" && Math.abs(d - a) / Math.max(Math.abs(a), 1) < 0.08;
function aiLinesTrusted(lines, ctx) {
  const allowed = [
    ctx.uniques, ctx.views, ctx.days, ctx.covered, Math.min(ctx.covered || 14, 14),
    ctx.stars, ctx.npmWeek, ctx.allTotal, ctx.funnel?.views, ctx.funnel?.home, ctx.funnel?.npm,
    ...(ctx.topRepos || []).map((r) => r.u),
    ctx.starGrowth?.span, ctx.starGrowth?.delta,
    ctx.external?.issues?.length, ctx.external?.pulls?.length,
    // 明细里的编号、发版前后的日均、最热页面的次数，都会原样出现在 prompt 里
    ...(ctx.external?.issues || []).map((i) => i.number),
    ...(ctx.external?.pulls || []).map((p) => p.number),
    ...(ctx.impacts || []).flatMap((i) => [i.before?.views?.avg, i.after?.views?.avg, i.before?.npm?.avg, i.after?.npm?.avg]),
    ctx.impact?.before?.views?.avg, ctx.impact?.after?.views?.avg,
    ctx.impact?.before?.npm?.avg, ctx.impact?.after?.npm?.avg,
    ...(ctx.paths || []).slice(0, 3).map((p) => p.n),
  ].filter((v) => typeof v === "number");
  for (const line of lines) {
    if (/^[^\d]{0,4}个仓库/.test(line.trim())) return false;
    // 千分位要整体当一个数，否则 9,382 会被拆成 9 和 382 再被拒
    for (const m of line.matchAll(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万|人|次|条|个)?/g)) {
      const v = Number(String(m[1]).replace(/,/g, "")) * (m[2] === "万" ? 10000 : 1);
      if (v < 200) continue;
      if (!allowed.some((a) => near(v, a))) return false;
    }
  }
  return true;
}

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
    // 推理模型会把 token 花在思考上，留够正文的额度，不然回来是空串
    max_tokens: 3000,
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
      // 推理模型写两三句话要几十秒，给足时间，不然每次都被 abort 退回模板
      signal: AbortSignal.timeout(55000),
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
        max_tokens: 4000,
        messages: [...body.messages, { role: "user", content: "用两句话总结上面这些数字，直接给正文。" }],
      });
    }
    if (!text) throw new Error("empty");
    // 一天窗口里「1 天内浏览」「1 天新增」既不自然，也和 KPI 上的日期对不上，换成具体日期
    if (ctx.days === 1 && ctx.day) {
      const dd = String(ctx.day).slice(5);
      text = text.replace(/(?<![\d])1\s*天内?/g, dd);
      text = text.replace(/近?\s*14\s*天(?=\s*访客)/g, dd);
    }
    // 四位以上整数补千分位，跟界面上的数字写法一致
    text = text.replace(/\b\d{4,}\b/g, (m) => Number(m).toLocaleString("en-US"));
    // 汉字和数字之间留空格，跟界面上的排版一致
    text = text.replace(/([\u4e00-\u9fa5])(\d)/g, "$1 $2").replace(/(\d)([\u4e00-\u9fa5])/g, "$1 $2");
    text = text.replace(/([\u4e00-\u9fa5])([A-Za-z])/g, "$1 $2").replace(/([A-Za-z])([\u4e00-\u9fa5])/g, "$1 $2");
    // issue8 / PR5 这种也要断开，但版本号、仓库名里的数字不动
    text = text.replace(/\b(issues?|PRs?|stars|npm)(?=\d)/g, "$1 ");
    // 「近 14 天访客…，7 天浏览…」是两个跨度，断成两句，别让人当成同期
    text = text.replace(/，(?=近?\s*\d+\s*天内?[^。；]{0,2}(?:浏览|访客))/g, "。");
    // 去掉列表前缀时要留住开头的数字，「14 天访客」不能被当成「14. 」删掉
    // 模型被长度截断时末句会悬空，别让面板停在「8,403 次，」
    text = text.replace(/[，、；：,]+\s*$/, "").replace(/([^。！？!?\s])$/, "$1。");
    const lines = text.split(/\n+/).map((s) => s.replace(/^\s*(?:[-*•]\s+|\d{1,2}[.、)]\s+)/, "").trim()).filter(Boolean).slice(0, 3);
    if (!lines.length || !aiLinesTrusted(lines, ctx)) return { source: "template", lines: templateSummary(ctx), error: "checked", raw: lines };
    return { source: "ai", lines, model };
  } catch (e) {
    return { source: "template", lines: templateSummary(ctx), error: String(e.message || e) };
  }
}
