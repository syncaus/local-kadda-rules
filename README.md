# @local/kadda-rules

把工作规则和分阶段开发流程带进 DeepSeek Harness。

## 做什么

三层，后两层可以单独关：

**1. 提示词（规则 + 流程）**

- 规则：包里的 `rules/KADDA.md` 作为系统提示词 section 注入每次请求，位置在 persona 前缀之后、plan 策略之前。规则里指南的引用改写成包内 `guides/` 的绝对路径。装进 profile 的是实体副本，改了规则文件要重装插件才生效；读不到时 section 里出现一条可见提示。
- 流程：`flow/workflow.md` 作为第二个 section，把「探索 → 计划 → 执行 → 验证 → 审查 → 汇报」六个阶段写成表，每个阶段对应 Harness 里真实的工具名（`exit_plan_mode`、`todo_write`、`ask_user_question`、`subagent`）和出口条件。

**2. 命令（可选）**

流程不靠命令激活：两个 section 每轮都注入，模型按流程自己走。下面这三个命令只是手动跳到某一阶段的快捷方式，不输入它们流程照走。

| 命令 | 作用 |
|---|---|
| `/dev <任务>` | 进入计划模式并下发任务：先只读探索，再用 `exit_plan_mode` 提交带验证判据的计划，批准后才动手 |
| `/verify [补充]` | 阶段 4：对本会话的改动逐条跑判据，贴输出 |
| `/review [补充]` | 阶段 5：`git diff` + 3 轮逻辑审查，改动大时交给 subagent 独立审 |

**3. 门禁（代码强制，不靠模型自觉）**

- 计划门禁：会话处于计划模式时，`edit` / `write` / `apply_patch` / `str_replace_editor`（非 view）在 `tools/pre-execute` 被拒绝，模型收到理由。Harness 自带的计划模式只是提示词约束，这一层把它变成硬约束。
- 收尾门禁：回合要结束时（`agent/turn-stopping`），如果本轮成功改过文件、之后没有运行过任何命令，或 todo 清单还有未完成项，就把模型打回去一次。被拒绝的写入不算「改过文件」。每回合最多一次，模型说明「无法验证，因为…」后回合照常结束，不会死循环。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，四个开关默认都是 `true`：

```yaml
- id: kadda-rules
  config:
    workflow: true   # 流程 section
    commands: true   # /dev /verify /review
    planGate: true   # 计划模式禁改文件
    stopGate: true   # 改完未验证不让回合结束
```

## 已知边界

- 计划门禁靠会话的 `plan/mode` 事件跟踪状态。Harness 重启后恢复的旧会话，在下一次切换模式之前状态未知，门禁对它不生效（放行）。
- 计划门禁只拦上面列出的写入工具。用 `pwsh` 之类执行命令写文件不在拦截范围内。
- 收尾门禁判断的是「改完之后有没有运行过命令」，不判断命令是不是真的在验证。它防的是改完直接报完成，不替代第 7 节。
- 门禁发回给模型的话以用户消息的形式出现在对话里，前缀 `[开发流程门禁]`。
- 子代理同样受这两条门禁约束。

## 规则文件

`rules/KADDA.md` 是注入的规则正文，`guides/` 是规则里「按需必读」指向的两份指南。它们都随包发布。

装进 profile 的是一份实体副本，所以改完这两处要重装插件才生效（`plugin_manager` 里先移除再装，或对 `file:` 依赖重新安装）。

## 边界

- 项目自己的 `AGENTS.md` 等项目级指令文件优先：section 首句写明冲突时以项目为准（与规则第 4 节一致）。
- 不是 UI 插件：插件列表里可见标题、描述、图标，界面里没有额外页面；命令出现在 `/` 菜单里。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件：两个 section（`kadda-rules:work-rules` order 100、`kadda-rules:workflow` order 110）、三个命令、两条门禁 |
| `flow/workflow.md` | 开发流程六阶段，随包发布，不读外部文件 |
| `rules/KADDA.md` | 工作规则正文，注入为第一个 section |
| `guides/` | `backend-rules.md`、`closed-loop.md`，规则里按需读取 |
| `cordis.patch.yml` | bundle patch，插入 `kadda-rules` 行 |
| `locale/*.json`、`icon.svg` | 插件列表的标题、描述、图标 |
