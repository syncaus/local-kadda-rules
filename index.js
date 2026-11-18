/**
 * Host half of the kadda-rules bundle.
 *
 * Three layers, each one optional beyond the first:
 *
 * 1. Prompt: the work rules shipped with this package plus a staged
 *    development workflow, as two system-prompt sections.
 * 2. Entry points: `/dev`, `/verify`, `/review` commands that start a stage.
 * 3. Gates: plan mode refuses file-mutating tools, and a turn that edited
 *    files without running anything afterwards (or left todos open) is sent
 *    back once before it may end.
 *
 * Every path is resolved at runtime: the source carries no machine-specific
 * absolute path.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'kadda-rules'
export const inject = ['systemPrompt']

/** This package's own directory, resolved from the installed location. */
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Roots shipped inside the package. */
const BUNDLED_RULES = join(PACKAGE_DIR, 'rules', 'KADDA.md')
const BUNDLED_GUIDES = join(PACKAGE_DIR, 'guides')
const WORKFLOW_FILE = join(PACKAGE_DIR, 'flow', 'workflow.md')

/** Stable names, unique among prompt sections. */
const RULES_SECTION = 'kadda-rules:work-rules'
const WORKFLOW_SECTION = 'kadda-rules:workflow'

/** Placement between DEPLOYMENT_PERSONA_PREFIX (0) and PLAN_POLICY (500). */
const RULES_ORDER = 100
const WORKFLOW_ORDER = 110

const PREAMBLE = '以下为用户全局工作规则，适用于所有会话。项目自己的 AGENTS.md 等项目级指令文件与它冲突时以项目为准。'

/** Tools that change files; `str_replace_editor` only when it is not viewing. */
const MUTATING_TOOLS = new Set(['edit', 'write', 'apply_patch', 'str_replace_editor'])

/** Tools whose run counts as "something was executed after the edit". */
const RUNNING_TOOLS = new Set(['bash', 'pwsh', 'terminal_send', 'run_code'])

/** Last successful rules read, keyed by source path, modification time, and size. */
let cache = { stamp: '', text: '' }

/**
 * Stat one path without throwing.
 * @param path - file to inspect.
 * @returns its stats, or undefined when it cannot be read.
 */
function statOf(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * Rewrite the guide references to an absolute, currently valid directory.
 *
 * The rules file names the guides with a `<guides>` placeholder, which the
 * `read` tool cannot resolve; the replacement is a function so no `$` pattern
 * in an expanded path is interpreted.
 * @param text - raw rules file content.
 * @param guides - directory to substitute for the placeholder.
 * @returns the content with absolute paths.
 */
function absolutize(text, guides) {
  return text
    .replaceAll('<guides>', () => guides)
    .replaceAll('~/', () => homedir() + sep)
}

/**
 * Read the shipped rules file, reusing cached text while it is unchanged.
 * @returns `{ rules: string }` on success, `{ notice: string }` when unreadable.
 */
function readRules() {
  const stat = statOf(BUNDLED_RULES)
  if (stat === undefined) return { notice: `工作规则插件没有规则可用：${BUNDLED_RULES} 读不到。` }
  const stamp = `${BUNDLED_RULES}:${stat.mtimeMs}:${stat.size}`
  if (stamp !== cache.stamp) {
    try {
      cache = { stamp, text: readFileSync(BUNDLED_RULES, 'utf8') }
    } catch (error) {
      return { notice: `工作规则插件读取 ${BUNDLED_RULES} 失败（${error.message}）。` }
    }
  }
  return { rules: absolutize(cache.text, BUNDLED_GUIDES) }
}

/**
 * Render the rules section; a failure yields the notice alone and an empty
 * rules file contributes no section at all.
 * @returns the section text for the current assembly.
 */
function rulesText() {
  const loaded = readRules()
  if (loaded.notice !== undefined) return loaded.notice
  const rules = loaded.rules.trim()
  return rules.length === 0 ? '' : `${PREAMBLE}\n\n${rules}`
}

/**
 * Read the workflow text once; it ships with the package and never changes
 * at runtime, which keeps the section byte-stable across requests.
 * @returns the workflow text, or a visible notice when the file is missing.
 */
function readWorkflow() {
  try {
    return readFileSync(WORKFLOW_FILE, 'utf8').trim()
  } catch (error) {
    return `开发流程文件读取失败：${WORKFLOW_FILE}（${error.message}）。`
  }
}

/**
 * Freeze a plain JSON value in depth.
 * @param value - value to freeze.
 * @returns the same value, frozen.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * The host's own message constructor, when this package can resolve it. The
 * import settles long before any command or gate fires; until then, and when
 * the package is not resolvable from here, {@link message} builds the same
 * shape by hand.
 */
let createUserMessage
import('@deepseek-ai/dsh-llm').then(
  (module) => { createUserMessage = module.createUserMessage },
  () => {},
)

/**
 * Build one user-role text message (identified and frozen, as the host does).
 * @param text - model-facing text.
 * @returns the message.
 */
function message(text) {
  const input = { content: [{ type: 'text', text }], source: { kind: 'user' } }
  return typeof createUserMessage === 'function'
    ? createUserMessage(input)
    : deepFreeze({ ...input, id: randomUUID(), role: 'user' })
}

/**
 * Whether one tool call changes files.
 * @param exec - the tool execution.
 * @returns true for a mutating call.
 */
function isMutation(exec) {
  if (!MUTATING_TOOLS.has(exec.name)) return false
  return !(exec.name === 'str_replace_editor' && exec.arguments?.command === 'view')
}

const KICKOFF = task => `按「开发流程」走完整六个阶段处理下面的任务。现在是阶段 1（探索）和阶段 2（计划）：只读代码，不改文件；计划每步带能独立跑的验证判据，用 exit_plan_mode 提交。

任务：${task}`

const VERIFY = extra => `进入「开发流程」阶段 4（验证）。针对本会话到目前为止的全部改动：
1. 列出每一步的验证判据，逐条实际运行（编译、测试、从真实入口触发），贴关键输出。
2. 报「测试通过」前核对用例真跑了：通过数、SKIP 数是否符合预期。
3. 没跑通或跑不了的，写明卡在哪、缺什么，不写「完成」。${extra === '' ? '' : `\n\n补充要求：${extra}`}`

const REVIEW = extra => `进入「开发流程」阶段 5（审查）。先用 git diff 取得本次全部改动，然后做 3 轮逻辑审查，每轮各看一项：① 条件判断；② 边界处理；③ 数据流转。改动超过一两个文件时，交给 subagent 独立审：只给它 diff 和原始需求，不给你的结论。
逐轮报告发现；有问题就修，修完重新验证被改到的部分。${extra === '' ? '' : `\n\n补充要求：${extra}`}`

/**
 * Register sections, commands, and gates on the plugin's own context, so
 * unloading the plugin removes all of them.
 * @param ctx - the plugin context.
 * @param config - `{ workflow, commands, planGate, stopGate }`, each default true.
 */
export function apply(ctx, config = {}) {
  const enabled = key => config?.[key] !== false
  const logger = ctx.logger?.('kadda-rules')

  // ---- layer 1: prompt ----
  ctx.systemPrompt.section({
    name: RULES_SECTION,
    order: RULES_ORDER,
    interpolate: false,
    text: rulesText,
  })
  if (enabled('workflow')) {
    const workflow = readWorkflow()
    ctx.systemPrompt.section({
      name: WORKFLOW_SECTION,
      order: WORKFLOW_ORDER,
      interpolate: false,
      text: workflow,
    })
  }

  // ---- per-session state the gates read ----
  /** Session → `{ plan, dirty, openTodos, nudgedTurn }`. */
  const states = new WeakMap()
  const stateOf = (session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = { plan: false, dirty: false, openTodos: 0, nudgedTurn: -1 }
      states.set(session, state)
    }
    return state
  }

  // Plan mode lives in a per-session realm this host-plane plugin cannot
  // inject, so follow its durable `plan/mode` event instead. A session
  // resumed after a restart is unknown until its mode next changes; the plan
  // gate stays open for it.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'plan/mode') stateOf(session).plan = event.data?.active === true
  })

  ctx.on('tools/result', (exec, result) => {
    const session = exec.agent?.session
    if (session === undefined) return
    const state = stateOf(session)
    if (state.plan) return
    // A denied edit never reached the file; a failed command still counts as having run.
    if (isMutation(exec)) {
      if (result?.isError !== true) state.dirty = true
    } else if (RUNNING_TOOLS.has(exec.name)) state.dirty = false
    else if (exec.name === 'todo_write' && Array.isArray(exec.arguments?.todos)) {
      state.openTodos = exec.arguments.todos.filter(todo => todo?.status !== 'completed').length
    }
  })

  // ---- layer 3: gates ----
  if (enabled('planGate')) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const session = exec.agent?.session
      if (session !== undefined && stateOf(session).plan && isMutation(exec)) {
        return {
          kind: 'deny',
          reason: '计划模式下不改文件。继续只读探索，计划写好后用 exit_plan_mode 提交，用户批准后再动手。',
        }
      }
      return next()
    })
  }

  if (enabled('stopGate')) {
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal?.aborted) return
      const state = stateOf(agent.session)
      // One objection per turn: the model may answer "cannot verify because…"
      // and the turn then closes, so this never loops.
      if (state.plan || state.nudgedTurn === turn) return
      const reasons = []
      if (state.dirty) {
        reasons.push('本轮改了文件，但改完之后没有运行任何命令。按工作规则第 7 节先验证（编译、测试或判据命令），贴关键输出；确实无法验证就写明卡在哪、缺什么。')
      }
      if (state.openTodos > 0) {
        reasons.push(`todo 清单还有 ${state.openTodos} 条未完成。做完并标 completed；本轮不做的，说明原因并更新清单。`)
      }
      if (reasons.length === 0) return
      state.nudgedTurn = turn
      state.dirty = false
      try {
        agent.steer(message(`[开发流程门禁] 回合还不能结束：\n- ${reasons.join('\n- ')}`))
      } catch (error) {
        logger?.warn?.('kadda-rules: stop gate could not steer: %o', error)
      }
    })
  }

  // ---- layer 2: entry points (only when a command registry is composed) ----
  if (enabled('commands')) {
    ctx.inject(['commands'], (commandCtx) => {
      const commands = commandCtx.commands
      commands.register({
        name: 'dev',
        description: '按开发流程处理任务：探索 → 计划 → 执行 → 验证 → 审查 → 汇报',
        input: { hint: '<任务描述>' },
        handler: async (invocation) => {
          const task = invocation.rawInput.trim()
          if (task === '') return { kind: 'error', text: '用法：/dev <任务描述>' }
          const plan = commands.find(invocation.agent, 'plan')
          if (plan === undefined) {
            invocation.agent.steer(message(KICKOFF(task)))
            return { kind: 'success', text: '已按开发流程开始（本会话没有计划模式，计划以文字给出）。' }
          }
          // Reuse `/plan <message>`: it enters plan mode, then steers the message.
          const result = await plan.handler({ ...invocation, rawInput: ` ${KICKOFF(task)}`, attachments: [] })
          return result.kind === 'error'
            ? result
            : { kind: 'success', text: '已进入计划模式，按开发流程开始：先探索，再提交计划。' }
        },
      })
      commands.register({
        name: 'verify',
        description: '开发流程阶段 4：对本会话的改动逐条跑验证判据',
        input: { hint: '[补充要求]' },
        handler: ({ agent, rawInput }) => {
          agent.steer(message(VERIFY(rawInput.trim())))
          return { kind: 'success', text: '开始验证。' }
        },
      })
      commands.register({
        name: 'review',
        description: '开发流程阶段 5：对本会话的改动做 3 轮逻辑审查',
        input: { hint: '[补充要求]' },
        handler: ({ agent, rawInput }) => {
          agent.steer(message(REVIEW(rawInput.trim())))
          return { kind: 'success', text: '开始审查。' }
        },
      })
    })
  }
}
