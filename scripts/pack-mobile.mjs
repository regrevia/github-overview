// 把网页和数据引擎装进 Android 的 assets，让手机不依赖任何服务进程。
// 只在打包时跑：assets 是产物，不提交（源在 public/ 和 src/）。
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps/mobile/app/src/main/assets");

// 少一个就是白屏：三个都必须在
const WEB = ["index.html", "standalone.js", "engine.bundle.js"];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "web"), { recursive: true });

let bytes = 0;
const put = (from, to) => {
  const src = join(root, from);
  let size;
  try {
    size = statSync(src).size;
  } catch {
    throw new Error(`缺少 ${from}`);
  }
  copyFileSync(src, to);
  bytes += size;
  return size;
};

for (const f of WEB) {
  const to = join(out, "web", f);
  put(`public/${f}`, to);
  // 装进 App 的脚本里只要有一个 node: 引用，手机就会白屏
  if (/\bfrom\s+["']node:|\brequire\(["']node:/.test(readFileSync(to, "utf8"))) {
    throw new Error(`${f} 里还有 node: 依赖，手机端跑不起来`);
  }
}
console.log(`assets: ${WEB.length} 个文件 · ${(bytes / 1024).toFixed(0)} KB`);
