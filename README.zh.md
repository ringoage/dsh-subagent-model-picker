# dsh-subagent-model-picker

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可视化、手动子代理模型选择器。**

在主模型选择器旁边，为每一个进程内子代理挑一个更便宜 / 更快的模型（以及思考程度），
按会话持久化，零猜测。

## 为什么做它

「给子代理换便宜模型」这两天被做了很多遍，但它们都是**替你决定**：

| 方案 | 如何选择 | 谁决定 | 可预测？ |
| --- | --- | --- | --- |
| 工具式 | 模型自己调用一个工具 | 模型 | ❌ 依赖当次运行 |
| 自动式 | 规则 / 计划模式判断 | 插件的策略 | ⚠️ 只跟它的规则一样好 |
| 命令式 | 你输入 `/命令` | 你，命令式 | ✅ 但无可视状态 |
| **手动 GUI（本项目）** | **主模型座旁的座位** | **你，可视化** | ✅ 确定 + 始终可见 |

`dsh-subagent-model-picker` 是这个分类里**唯一一个可视化、手动**的选择器：
主模型座旁的一个 GUI 控件，选择显式、一眼可见，并**确定性地覆盖每一条子代理路径**。

## 它给你什么

- **手动** — 你来选；不是策略，也不是模型自己。
- **可视化** — 主模型座旁的下拉（悬停胶囊 + 点击外部收起 + Esc）。
- **可预测** — 选择是会话状态；每个子代理都拿到你选的那个。
- **全局覆盖** — 一个 host 侧 `agent/request` 监听器覆盖 `subagent`、`subagent_fork` 与 workflow 扇出（任意深度）。
- **思考程度** — 提供推理等级的模型（如 `off` / `high` / `max`）会有对应的「思考程度」菜单。
- **默认继承** — 在你选择之前，子代理沿用主模型。
- **按会话 + 持久** — 选择跟随会话，重启后仍保留。
- **本地化** — `zh` / `en` 文案。

## 互补，而非替代

自动路由插件（tier/smart/adaptive 路由、计划模式分类）与工具式 / 命令式回答的是
「**替我选**」；本项目回答的是「**让我选**」。它们可以组合：把自动路由当默认策略，
再用本选择器手动覆盖某个会话——或反过来。

## 工作原理

两个半区协作，完全不触碰 apiProxy 的 settings 白名单：

1. **Host 半区**（`lib/index.js`）注册一个 `agent/request` 瀑布监听器。`dsh-scope`
   允许事件**向上**冒泡，因此这个 host-root 监听器能看到所有 agent 的请求；子代理通过
   `agent.options.subagentDepth >= 1` 识别。它沿父链走到根会话，只对子代理覆盖
   `{ provider, model, reasoningEffort? }`。

2. **持久化 + 传输** 走一个 **Typert Remote 服务**（`subagent-model-picker`，wire 命名空间
   `subagent-model-picker`），暴露 `get` / `set` / `clear`。Client 半区挂载 Remote 贡献
   （`ctx.remote.$mount`）并调用 `remote.subagent-model-picker.*`；服务在 **host 侧**
   把 `sessionId -> { provider, model, reasoningEffort? }` 映射写入，因此完全不经过
   apiProxy 的 `exposedNamespaces()` 白名单。

## 安装

### 一行命令（GitHub，兼容插件市场）

```sh
dsh plugin --profile web add github:ringoage/dsh-subagent-model-picker
```

这就是插件市场使用的 `github:` 安装路径，可直接从本仓库安装。

### 手动（编辑 profile）

在你的 web profile（`.dsh/profiles/web/package.json`）中，把包加为依赖并列入
`dsh.profile.bundles`：

```json
{
  "dependencies": {
    "dsh-subagent-model-picker": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-subagent-model-picker"]
    }
  }
}
```

然后重启 harness。本地开发可用 `link:` 依赖指向本目录。

## 使用

主模型选择器左侧会出现 **子代理模型**。选择一个模型（若提供，再选**思考程度**），
该会话派生出的所有子代理都会使用它。选择「继承主模型（默认）」即可恢复默认路由。

## 限制

- 只路由 **进程内子代理**：`subagent`、`subagent_fork` 与 workflow 扇出子任务。
  外部 CLI agent（如 `claude-code`、`codex`）自行管理模型选择，不受影响。
- 选择器是 **Web 客户端** 功能；host 路由在 GUI 未打开时依然生效，但选项本身在 Web 输入框中编辑。

## 开发

- `lib/index.js` — host 半区（Remote 服务 + `agent/request` 路由）。
- `lib/client.js` — client 半区（slot UI + Remote 贡献 + locale）。
- `cordis.patch.yml` — 挂载插件行的 `dsh.bundle.patch` 插入层。

Remote 服务运行在 **SRC 模式**：方法用纯 JS 手动施加 `@Remote(name)` 契约（无需生成
`typert.host.js`），client 贡献则手写 strict 描述符。

## License

[MIT](./LICENSE)
