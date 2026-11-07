# 命运之牌（SillyTavern 独立扩展）

独立的 SillyTavern 前端扩展仓库，包含「命运之牌」插件：剧情预设与 `/director` 快捷命令、盲抽命运牌、章节标记与跳转。

本仓库从 [sillytavern-perf-lab](https://github.com/inthediatance4-dev/sillytavern-perf-lab)（基于 SillyTavern 1.19.0 的研究分支，提交 `6f8435f`）中拆出命运牌插件的源码，作为该插件的独立开发主线。好感度记忆是另一个独立插件，仍在 perf-lab 仓库维护，不在本仓库范围内。

## 签筒（明签模式，v1 已实现）

盲牌服务"让命运决定"的心情；签筒服务相反的心情——**我要自己挑，但给我更多材料**：

- 「求一筒」调用一次当前连接（隔离请求，不触碰正文钩子与长度设置），写出 12 支**明签**——每支是一句看得见的一句话方向，彼此不同、覆盖不同干预类型，并避开你拒签过的走向；
- 摇签不连模型，但受「运势」计量：摇 −1 运，每条新回复 +1 运，标记新章节回满——想多看几次命运，就让故事先走一步；
- 「上签」把签文变成一张已上手的命运牌，之后与盲牌完全同路：让意外发生、swipe/重新生成沿用、印记与日志照旧；一筒只可上一支签；
- 正文与存档永远不包含注入内容（私有区定界符 + 请求副本 + 世界书扫描排除，全部沿用现有机制）。

设计、规则与实现差异见 [docs/fate-tube-spec.md](docs/fate-tube-spec.md)。二期候选：把签文扩写成完整事件的「展开」。

## 仓库结构

```text
public/scripts/extensions/director/   插件源码（命运牌全部功能模块）
public/scripts/plugin-runtime/        兼容运行时（打包时进入 ZIP 的 runtime/）
public/lib/eventemitter.js            测试用本地依赖
public/scripts/a11y.js                测试用本地依赖
scripts/build-standalone-plugins.mjs  独立 ZIP 构建脚本（仅命运牌包）
tests/                                单元测试（node --test，离线可跑）
docs/fate-tube-spec.md                签筒规格草案
```

## 开发

```sh
npm install
npm test              # node --test tests/
npm run build:plugins # 产出独立安装 ZIP 到 .evidence/standalone-plugins/packages/
```

构建脚本校验源码导入边界：插件只能导入自身文件、`runtime/` 与宿主模块（`/script.js`、`/lib.js`、`/scripts/*` 非扩展模块、`extensions/shared.js`）；拒绝符号链接、密钥材料与本机绝对路径。相同源码与构建器产出字节一致的 ZIP（`build-info.json` 记录 SHA256）。

注：`tests/director-chapters.test.mjs` 中的宿主契约用例需要 perf-lab 检出中的 `public/script.js`；本仓库不内嵌宿主源码，该用例会自动跳过，宿主侧契约验证在 perf-lab 的 CI 中进行。

## 安装（构建产物）

解压整个 `st-director-fate-cards` 文件夹到酒馆的 `data/<用户标识>/extensions/`（供全部用户使用时放 `public/scripts/extensions/third-party/`），确认 `manifest.json` 直接位于扩展文件夹内，刷新页面后在扩展管理中启用「命运之牌」。使用已内置本功能的 perf-lab 分支时，先停用内置副本再启用第三方副本，同一功能只启用一份。无需为插件安装 Node.js 或 npm 依赖。

兼容验证目标：官方 SillyTavern 1.19.0 与 sillytavern-perf-lab 1.19.0。实际验证结果以随发布提供的报告为准。

## 已知限制

- 手动安装的 ZIP 不提供 Git 自动更新；更新前备份插件文件夹与酒馆数据。
- 群聊 regenerate 不沿用导演指令；命运牌按群组作用域只注入一次。
- 盲抽不是加密：私密事件以明文保存在聊天元数据中，导出或分享 JSONL 会暴露。

## 许可证

AGPL-3.0（见 [LICENSE](LICENSE)）。
