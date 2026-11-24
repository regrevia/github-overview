// 打成单文件经典脚本：file:// 和 Android WebView 都不支持模块时也能跑。
// 只在这里把引擎暴露到 window，页面别处只认 window.DGO_ENGINE。
import * as E from "../src/engine.mjs";
import { emptyStore, emptySlice, series } from "../src/store-core.mjs";

window.DGO_ENGINE = Object.assign({}, E, { emptyStore, emptySlice, series });
