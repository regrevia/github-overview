// 打成单文件经典脚本：file:// 和 Android WebView 都不支持模块时也能跑。
// 只在这里把引擎暴露到 window，页面别处只认 window.DGO_ENGINE。
// esbuild 的 es2019 目标不转译 Array.prototype.at；Android 7/8 的自带 WebView 没有它，
// 引擎里十几处 .at(-1) 会直接抛，先补上再加载引擎。
if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    writable: true, configurable: true,
    value: function (n) { var i = Math.trunc(Number(n)) || 0; return this[i < 0 ? this.length + i : i]; },
  });
}
import * as E from "../src/engine.mjs";
import { emptyStore, emptySlice, series } from "../src/store-core.mjs";

window.DGO_ENGINE = Object.assign({}, E, { emptyStore, emptySlice, series });
