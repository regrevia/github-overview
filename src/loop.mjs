// 同步节奏：CLI 和桌面端共用同一套，避免两边行为不一致。
// 绑定之前 targets 是空的，所以这里先盯着仓库数，一出现就立刻拉第一次。

export function startLoop(app, { intervalHours = 6, contribMinutes = 15, onLog = () => {} } = {}) {
  let contribTimer = null;
  let stopped = false;

  const contribTick = async () => {
    if (stopped) return;
    try {
      await app.syncContribs();
    } catch (e) {
      onLog(`贡献刷新失败：${e.message}`);
    }
  };

  const tick = async () => {
    if (stopped) return null;
    if (!app.count()) return null;
    try {
      const out = await app.sync();
      const failed = out.results.filter((r) => !r.ok);
      onLog(`同步 ${out.syncedAt}${failed.length ? `，${failed.length} 个失败` : ""}`);
      return out;
    } catch (e) {
      onLog(`同步失败：${e.message}`);
      return null;
    }
  };

  // 全量同步跑完再开高频通道，避免两边同时写同一份快照
  const startContrib = () => {
    if (contribTimer || stopped || contribMinutes <= 0) return;
    contribTimer = setInterval(contribTick, Math.max(3, contribMinutes) * 60e3);
    if (contribTimer.unref) contribTimer.unref();
  };

  const timer = setInterval(tick, Math.max(1, intervalHours) * 3600e3);
  if (timer.unref) timer.unref();

  let watch = null;
  if (app.count()) {
    tick().then(startContrib);
  } else {
    // 空配置：等前端绑完账号，仓库一出现就先拉一次，别等下一个周期
    let seen = 0;
    watch = setInterval(() => {
      if (stopped) return;
      const now = app.count();
      if (now && now !== seen) {
        seen = now;
        tick().then(startContrib);
      }
    }, 2000);
    if (watch.unref) watch.unref();
  }

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (watch) clearInterval(watch);
      if (contribTimer) clearInterval(contribTimer);
    },
  };
}
