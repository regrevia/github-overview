// 桌面端：Electron 的主进程本身就是 node，直接在里面起看板服务，
// 窗口只是指向 http://127.0.0.1:<端口>，不用另开子进程，也不会露出终端。
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// 打包后没有终端可看，把关键步骤写进日志文件，出问题能查
const LOG = path.join(require("node:os").tmpdir(), "github-overview-desktop.log");
const log = (...parts) => {
  try { fs.appendFileSync(LOG, new Date().toISOString() + " " + parts.map((x) => (x && x.stack) || String(x)).join(" ") + "\n"); } catch {}
};

// 配置和快照放系统的用户数据目录，卸载重装不丢
process.env.GITHUB_OVERVIEW_HOME = path.join(app.getPath("userData"), "data");
fs.mkdirSync(process.env.GITHUB_OVERVIEW_HOME, { recursive: true });

const resRoot = app.isPackaged ? path.join(process.resourcesPath, "app") : path.join(__dirname, "../../");
const SRC = path.join(resRoot, "src");

let win = null;
let appUrl = null;
let loop = null;

async function boot() {
  log("boot src=" + SRC);
  const { createApp } = await import("file://" + path.join(SRC, "server.mjs"));
  const { normalizeConfig, readConfig } = await import("file://" + path.join(SRC, "config.mjs"));
  const { startLoop } = await import("file://" + path.join(SRC, "loop.mjs"));
  const cfg = normalizeConfig(readConfig());
  // 没绑账号也照样起服务：窗口里先给绑定页
  const instance = createApp({ repos: cfg.repos, cfg });
  const addr = await instance.listen(0, "127.0.0.1");
  // 和 CLI 同一条同步节奏；绑定之后仓库出现会自动拉第一次
  loop = startLoop(instance, { intervalHours: cfg.intervalHours || 6, contribMinutes: cfg.contribMinutes ?? 15, onLog: (line) => log(line) });
  return { instance, url: `http://127.0.0.1:${addr.port}` };
}

function makeWindow(url) {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    title: "github-overview",
    backgroundColor: "#0f1115",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") },
  });
  win.loadURL(url);
  // 外链一律交给系统浏览器，别在应用窗口里开网页
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.on("closed", () => { win = null; });
  // 打包后窗口异常退出时也要留痕，否则只剩一句 all closed
  win.webContents.on("render-process-gone", (_e, d) => log("renderer gone", JSON.stringify(d)));
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log("did-fail-load", code, desc, url));
  win.webContents.on("did-finish-load", () => log("did-finish-load"));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }])
      : null,
  );
  try {
    const { url } = await boot();
    appUrl = url;
    makeWindow(url);
  } catch (e) {
    log("boot failed", e);
    const errWin = new BrowserWindow({ width: 560, height: 240, backgroundColor: "#0f1115" });
    errWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="font:13px/1.6 -apple-system;color:#e6e8ec;background:#0f1115;padding:28px">
       <b>看板服务没起来</b><p style="color:#98a1b0">${String(e.message || e)}</p></body>`));
  }
  // 从 Dock 再点开时把窗口叫回来；服务还没起好就先什么都不做，等 boot 建窗
  app.on("activate", () => { if (!win && appUrl) makeWindow(appUrl); });
});

app.on("window-all-closed", () => { log("all closed"); app.quit(); });
app.on("before-quit", () => { if (loop) loop.stop(); log("before-quit"); });
process.on("uncaughtException", (e) => log("uncaught", e));
process.on("unhandledRejection", (e) => log("unhandled", e));
