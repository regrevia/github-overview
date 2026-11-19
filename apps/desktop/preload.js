// 窗口里不需要 node 能力，保持最小暴露面；这里只留一个平台标记给样式用
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("githubOverviewDesktop", { platform: process.platform });
