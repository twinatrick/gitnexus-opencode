import { execFileSync } from "node:child_process"
import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin"
import {
  loadConfig,
  getDeprecatedConfigKeys,
  gitnexusCmd,
  buildAnalyzeArgs,
  checkGitNexusCliCompatibility,
  type CliRunner,
} from "./config.js"
import { discoverRepos } from "./discovery.js"
import { buildUserToast } from "./context.js"
import {
  createToolHooks,
  createMessagesTransformHandler,
  createSystemTransformHandler,
  createAnalyzeState,
} from "./hooks.js"
import { createHintEnvelopeState } from "./hint-envelope.js"
import { createLastInjectedRegistry } from "./last-injected.js"
import { createSessionRegistry, type SessionRegistry } from "./sessions.js"

const TOAST_DELAY_MS = 6000 // heuristic: waits past oh-my-openagent spinner animation

export function isGitNexusCliAvailable(options?: {
  env?: NodeJS.ProcessEnv
  execRunner?: CliRunner
}): boolean {
  return checkGitNexusCliCompatibility(options).compatible
}

async function hydrateSubagentRegistry(
  client: PluginInput["client"],
  registry: SessionRegistry,
  log: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<void> {
  try {
    const result = await client.session.list()
    const sessions = (result as { data?: Array<{ id?: string; parentID?: string }> })?.data ?? []
    let subagentCount = 0
    for (const s of sessions) {
      if (s?.id && s?.parentID) {
        registry.trackCreated({ id: s.id, parentID: s.parentID })
        subagentCount++
      }
    }
    log(
      `Hydrated subagent registry from session.list(): ${subagentCount} subagent(s) of ${sessions.length} session(s)`,
    )
  } catch (err) {
    log(
      `session.list() failed during hydration: ${err instanceof Error ? err.message : String(err)}. Unknown sessions will default to main (safe).`,
      "warn",
    )
  }
}

const plugin: Plugin = async ({ directory, worktree, client }) => {
  const scanRoot = worktree ?? directory
  const config = loadConfig(scanRoot)

  // COMP-002: CLI availability is tracked separately from graph/index state.
  // A missing CLI must never disable prompt injection for an existing index.
  let cliAvailable = false

  const log = (message: string, level: "debug" | "info" | "warn" | "error" = "info") => {
    void client.app.log({ body: { service: "gitnexus", level, message } })
  }

  // SEC-004: Legacy package-source keys are ignored. Warn once per plugin load
  // so users can remove stale `allowNpxFallback` / `gitnexusVersion` entries.
  for (const warning of getDeprecatedConfigKeys(scanRoot)) {
    log(
      `Ignoring deprecated ${warning.scope} config key(s): ${warning.keys.join(", ")}. ` +
        "This plugin never invokes npm/npx; install GitNexus locally or set GITNEXUS_BIN.",
      "warn",
    )
  }

  // Instance-scoped state. Each plugin(...) call — i.e. each workspace /
  // worktree OpenCode loads — gets its own caches and registries so two
  // workspaces running in the same node process cannot overwrite each
  // other's envelopes, refresh state, or session registries.
  const hintState = createHintEnvelopeState()
  const sessions = createSessionRegistry()
  const analyzeState = createAnalyzeState()
  const lastInjected = createLastInjectedRegistry()

  // Hydrate the subagent registry from existing sessions so plugin reloads
  // and session compactions don't misclassify long-lived subagents as main.
  // Fire-and-forget: a turn that races this hydration sees the unknown
  // session default to main, which is the safe (harmless) failure mode.
  void hydrateSubagentRegistry(client, sessions, log)

  const toolHooks = createToolHooks({
    cwd: scanRoot,
    config,
    canAnalyze: () => cliAvailable,
    analyzeState,
    hintState,
  })

  const messagesTransformHandler = createMessagesTransformHandler({
    isMain: (sessionID) => sessions.isMain(sessionID),
    getCache: () => hintState.getHintCache(),
    lastInjected,
    log,
  })

  const systemTransformHandler = createSystemTransformHandler({
    // Inject while the CLI is usable, or while a pre-existing index can still
    // provide graph context without any CLI call (COMP-002).
    shouldInject: () =>
      cliAvailable || hintState.getHintCache().freshness !== "missing",
    isMain: (sessionID) => sessions.isMain(sessionID),
    log,
  })

  const tools = {
    gitnexus_analyze: tool({
      description:
        "Build or refresh the GitNexus code knowledge graph for a repository. " +
        "Intended for the main agent; not delegated to subagents.",
      args: {
        path: tool.schema.string().optional().describe("Path to the git repository. Defaults to current directory."),
      },
      async execute(args) {
        const repoPath = args.path || scanRoot
        try {
          const compat = checkGitNexusCliCompatibility()
          if (!compat.compatible) {
            return `Failed to build graph: ${compat.reason ?? "Incompatible GitNexus CLI"}`
          }
          const cmd = gitnexusCmd()
          const analyzeArgs = buildAnalyzeArgs(repoPath, config)
          const result = execFileSync(
            cmd[0],
            [...cmd.slice(1), ...analyzeArgs],
            { encoding: "utf-8", timeout: 300000, cwd: repoPath },
          )
          return `Graph built successfully for ${repoPath}.\n${result}`
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Failed to build graph: ${msg}`
        }
      },
    }),
  }

  return {
    tool: tools,

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const info = (event.properties as { info?: { id?: string } } | undefined)?.info
        if (info?.id) {
          sessions.trackDeleted({ id: info.id })
          lastInjected.clear(info.id)
        }
        return
      }

      if (event.type !== "session.created") return

      try {
        const info = (event.properties as { info?: { id?: string; parentID?: string } } | undefined)?.info
        const sessionID = info?.id
        if (info?.id) sessions.trackCreated({ id: info.id, parentID: info.parentID })

        // COMP-002: Always refresh graph state and inject prompt context.
        // CLI availability only gates actions that need to execute the CLI.
        const repos = discoverRepos(scanRoot, (msg) => log(msg, "warn"))
        hintState.refreshHintCache(scanRoot)
        log(`Discovered ${repos.length} repo(s): ${repos.map((r) => r.name).join(", ") || "none"}`)

        const compat = checkGitNexusCliCompatibility()
        cliAvailable = compat.compatible

        if (!compat.compatible) {
          log(
            `Local GitNexus CLI unavailable (${compat.reason ?? "version check failed"}). ` +
              "Analyze and background refresh are disabled, but existing graph context stays active. " +
              "Install gitnexus locally or set GITNEXUS_BIN.",
            "warn",
          )
        } else if (config.autoRefreshStale) {
          for (const repo of repos) {
            if (repo.hasIndex && repo.isStale) {
              analyzeState.schedule(repo.path, config, scanRoot, hintState)
            }
          }
        }

        if (sessionID) {
          log(`Session ${sessionID} ready; envelope will be injected via messages.transform when eligible`)
        }

        const toastMessage = buildUserToast(repos)
        if (toastMessage) {
          // Delay toast so it appears after oh-my-openagent's 5s spinner animation
          setTimeout(() => {
            client.tui.showToast({
              body: {
                title: "GitNexus",
                message: toastMessage,
                variant: "info",
                duration: 5000,
              },
            }).catch(() => {})
          }, TOAST_DELAY_MS)
        }
      } catch (err) {
        log(`session.created handler error: ${err instanceof Error ? err.message : String(err)}`, "error")
      }
    },

    "tool.execute.after": async (input, output) => {
      toolHooks.onToolExecuteAfter(input, output)
    },

    "experimental.chat.messages.transform": async (input, output) => {
      await messagesTransformHandler(input, output)
    },

    "experimental.chat.system.transform": async (input, output) => {
      await systemTransformHandler(input, output)
    },
  }
}

export default plugin
