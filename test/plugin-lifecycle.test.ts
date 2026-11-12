import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { execFileSync } from "node:child_process"
import plugin from "../src/index.js"
import { OPT_IN_MARKER } from "../src/hint-envelope.js"

interface TestLog {
  level?: string
  message: string
}

interface Harness {
  hooks: Awaited<ReturnType<typeof plugin>>
  logs: TestLog[]
}

const SESSION_ID = "ses_main"

function initGitRepo(repoDir: string, withIndex: boolean): string {
  execFileSync("git", ["init", "-q"], { cwd: repoDir })
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repoDir })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir })
  writeFileSync(join(repoDir, "README.md"), "# test\n")
  execFileSync("git", ["add", "."], { cwd: repoDir })
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir })
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf-8",
  }).trim()

  if (withIndex) {
    mkdirSync(join(repoDir, ".gitnexus"), { recursive: true })
    writeFileSync(
      join(repoDir, ".gitnexus", "meta.json"),
      JSON.stringify({ lastCommit: head }),
    )
  }
  return head
}

async function createHarness(
  repoDir: string,
  sessionListImpl: () => Promise<{ data: Array<{ id?: string; parentID?: string }> }> = async () => ({
    data: [],
  }),
): Promise<Harness> {
  const logs: TestLog[] = []
  const client = {
    app: {
      log: async (input: { body: TestLog }) => {
        logs.push(input.body)
      },
    },
    session: { list: sessionListImpl },
    tui: { showToast: async () => {} },
  }
  const hooks = await plugin({
    directory: repoDir,
    worktree: repoDir,
    client,
  } as never)
  return { hooks, logs }
}

async function startSession(hooks: Harness["hooks"]): Promise<void> {
  await hooks.event!({
    event: {
      type: "session.created",
      properties: { info: { id: SESSION_ID } },
    },
  } as never)
}

describe("COMP-002 / SEC-004: plugin lifecycle without a package manager", () => {
  let tmpRoot: string
  let repoDir: string
  let homeDir: string
  let savedHome: string | undefined
  let savedDisable: string | undefined
  let savedBin: string | undefined

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gitnexus-lifecycle-"))
    repoDir = join(tmpRoot, "repo")
    homeDir = join(tmpRoot, "home")
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    savedHome = process.env.HOME
    savedDisable = process.env.GITNEXUS_DISABLE_LOCAL_BIN
    savedBin = process.env.GITNEXUS_BIN
    process.env.HOME = homeDir
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedDisable === undefined) delete process.env.GITNEXUS_DISABLE_LOCAL_BIN
    else process.env.GITNEXUS_DISABLE_LOCAL_BIN = savedDisable
    if (savedBin === undefined) delete process.env.GITNEXUS_BIN
    else process.env.GITNEXUS_BIN = savedBin
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("keeps graph injection active when the CLI is missing but an index exists", async () => {
    initGitRepo(repoDir, true)
    process.env.GITNEXUS_DISABLE_LOCAL_BIN = "1"
    delete process.env.GITNEXUS_BIN
    // A malicious repo config and .npmrc must not matter to lifecycle behavior.
    mkdirSync(join(repoDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(repoDir, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ allowNpxFallback: true, gitnexusVersion: "npm:attacker@1.0.0" }),
    )
    writeFileSync(join(repoDir, ".npmrc"), "registry=https://attacker.example.com/\n")

    const { hooks, logs } = await createHarness(repoDir)
    await startSession(hooks)

    const system = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: SESSION_ID, model: {} } as never,
      system as never,
    )
    assert.equal(system.system.length, 2, "system addendum must still be injected")

    const messages = {
      messages: [
        {
          info: { role: "user", sessionID: SESSION_ID },
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!(
      {} as never,
      messages as never,
    )
    assert.match(
      (messages.messages[0]!.parts[0] as { text: string }).text,
      /^<gitnexus_graph /,
      "graph envelope must still be injected",
    )

    const result = await hooks.tool!.gitnexus_analyze.execute!(
      { path: repoDir } as never,
      {} as never,
    )
    assert.match(String(result), /^Failed to build graph:/)
    assert.match(String(result), /never downloads packages/)

    assert.ok(
      logs.some((entry) => entry.message.includes("Ignoring deprecated repository config")),
      "deprecated repository keys should be reported",
    )
  })

  it("injects nothing when there is neither a CLI nor an index", async () => {
    initGitRepo(repoDir, false)
    process.env.GITNEXUS_DISABLE_LOCAL_BIN = "1"
    delete process.env.GITNEXUS_BIN

    const { hooks } = await createHarness(repoDir)
    await startSession(hooks)

    const system = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: SESSION_ID, model: {} } as never,
      system as never,
    )
    assert.deepEqual(system.system, ["base prompt"])

    const messages = {
      messages: [
        {
          info: { role: "user", sessionID: SESSION_ID },
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!(
      {} as never,
      messages as never,
    )
    assert.equal(
      (messages.messages[0]!.parts[0] as { text: string }).text,
      "hello",
    )

    const result = await hooks.tool!.gitnexus_analyze.execute!(
      { path: repoDir } as never,
      {} as never,
    )
    assert.match(String(result), /^Failed to build graph:/)
  })

  it("runs the local CLI with --index-only when it is present (no npm/npx)", async () => {
    initGitRepo(repoDir, true)
    const marker = join(tmpRoot, "analyze-args.log")
    const binDir = join(tmpRoot, "bin")
    mkdirSync(binDir, { recursive: true })
    const fakeCli = join(binDir, "gitnexus")
    writeFileSync(
      fakeCli,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "1.6.12"; exit 0; fi',
        'if [ "$1" = "analyze" ] && [ "$2" = "--help" ]; then echo "  --index-only"; exit 0; fi',
        `printf '%s\\n' "$@" >> "${marker}"`,
        'echo "graph built"',
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(fakeCli, 0o755)

    delete process.env.GITNEXUS_DISABLE_LOCAL_BIN
    process.env.GITNEXUS_BIN = fakeCli

    const { hooks } = await createHarness(repoDir)
    await startSession(hooks)

    const system = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: SESSION_ID, model: {} } as never,
      system as never,
    )
    assert.equal(system.system.length, 2)

    const result = await hooks.tool!.gitnexus_analyze.execute!(
      { path: repoDir } as never,
      {} as never,
    )
    assert.match(String(result), /^Graph built successfully/)

    assert.equal(existsSync(marker), true)
    const args = readFileSync(marker, "utf-8").split("\n").filter(Boolean)
    assert.deepEqual(args, ["analyze", "--index-only", repoDir])
  })

  it("SEC-005: session startup does NOT execute repository-controlled binaries or malicious which/where on PATH", async () => {
    initGitRepo(repoDir, true)
    const hijackMarker = join(tmpRoot, "startup-hijack.log")
    const nmBinDir = join(repoDir, "node_modules", ".bin")
    const evilShimDir = join(tmpRoot, "evil-shims")
    mkdirSync(nmBinDir, { recursive: true })
    mkdirSync(evilShimDir, { recursive: true })

    for (const target of [
      join(repoDir, "gitnexus"),
      join(nmBinDir, "gitnexus"),
      join(evilShimDir, "which"),
      join(evilShimDir, "where"),
    ]) {
      writeFileSync(target, `#!/bin/sh\necho hijacked >> "${hijackMarker}"\necho "1.6.12"\nexit 0\n`)
      chmodSync(target, 0o755)
    }

    const savedPath = process.env.PATH
    try {
      delete process.env.GITNEXUS_DISABLE_LOCAL_BIN
      delete process.env.GITNEXUS_BIN
      process.env.PATH = [".", repoDir, nmBinDir, evilShimDir].join(delimiter)

      const { hooks } = await createHarness(repoDir)
      await startSession(hooks)

      assert.equal(
        existsSync(hijackMarker),
        false,
        "session startup must never execute repo binaries or which/where shims",
      )
    } finally {
      process.env.PATH = savedPath
    }
  })

  it("SEC-006: client.session.list() failure during hydration fails closed for unknown sessions", async () => {
    initGitRepo(repoDir, true)
    process.env.GITNEXUS_DISABLE_LOCAL_BIN = "1"
    delete process.env.GITNEXUS_BIN

    const { hooks } = await createHarness(repoDir, async () => {
      throw new Error("session.list RPC unavailable")
    })
    // Populate hint cache via a known main session creation
    await startSession(hooks)

    // An unclassified subagent (never seen in session.created or session.list) must be denied
    const unknownSubagentMessages = {
      messages: [
        {
          info: { role: "user", sessionID: "ses_unclassified_subagent" },
          parts: [{ type: "text", text: "unclassified subagent prompt" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!(
      {} as never,
      unknownSubagentMessages as never,
    )
    assert.equal(
      (unknownSubagentMessages.messages[0]!.parts[0] as { text: string }).text,
      "unclassified subagent prompt",
      "unknown subagent must not receive graph envelope when session.list() fails",
    )
  })

  it("SEC-006: hydration race condition fails closed while in flight and restores main/subagent classification after plugin reload", async () => {
    initGitRepo(repoDir, true)
    process.env.GITNEXUS_DISABLE_LOCAL_BIN = "1"
    delete process.env.GITNEXUS_BIN

    let resolveList!: (val: { data: Array<{ id?: string; parentID?: string }> }) => void
    const delayedList = new Promise<{ data: Array<{ id?: string; parentID?: string }> }>((res) => {
      resolveList = res
    })

    const { hooks } = await createHarness(repoDir, () => delayedList)
    // Refresh cache via a bootstrap session
    await startSession(hooks)

    // 1. Race condition: before session.list() resolves, pre-existing reloaded sessions are still "unknown"
    const racingSubagent = {
      messages: [
        {
          info: { role: "user", sessionID: "ses_reloaded_sub" },
          parts: [{ type: "text", text: "subagent racing hydration" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, racingSubagent as never)
    assert.equal(
      (racingSubagent.messages[0]!.parts[0] as { text: string }).text,
      "subagent racing hydration",
      "unhydrated session must fail closed while hydration is in flight",
    )

    // 2. Complete hydration (simulating plugin reload with existing main + subagent sessions)
    resolveList({
      data: [
        { id: "ses_reloaded_main" },
        { id: "ses_reloaded_sub", parentID: "ses_reloaded_main" },
      ],
    })
    await delayedList
    await new Promise((r) => setImmediate(r))

    // Hydrated main session receives envelope automatically
    const mainTurn = {
      messages: [
        {
          info: { role: "user", sessionID: "ses_reloaded_main" },
          parts: [{ type: "text", text: "main prompt after reload" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, mainTurn as never)
    assert.match(
      (mainTurn.messages[0]!.parts[0] as { text: string }).text,
      /^<gitnexus_graph /,
      "hydrated main session must receive graph envelope",
    )

    // Hydrated subagent without marker is denied
    const subNoMarker = {
      messages: [
        {
          info: { role: "user", sessionID: "ses_reloaded_sub" },
          parts: [{ type: "text", text: "subagent without marker after reload" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, subNoMarker as never)
    assert.equal(
      (subNoMarker.messages[0]!.parts[0] as { text: string }).text,
      "subagent without marker after reload",
    )

    // Hydrated subagent WITH marker receives envelope
    const subWithMarker = {
      messages: [
        {
          info: { role: "user", sessionID: "ses_reloaded_sub" },
          parts: [{ type: "text", text: `${OPT_IN_MARKER} subagent with marker after reload` }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, subWithMarker as never)
    assert.match(
      (subWithMarker.messages[0]!.parts[0] as { text: string }).text,
      /^<gitnexus_graph /,
      "hydrated subagent with marker must receive graph envelope",
    )

    // 3. session.deleted reverts session to "unknown" and must NOT grant main access
    await hooks.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_reloaded_sub" } },
      },
    } as never)

    const afterDelete = {
      messages: [
        {
          info: { role: "user", sessionID: "ses_reloaded_sub" },
          parts: [{ type: "text", text: "turn after session.deleted" }],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, afterDelete as never)
    assert.equal(
      (afterDelete.messages[0]!.parts[0] as { text: string }).text,
      "turn after session.deleted",
      "deleted session must revert to unknown and never receive main access",
    )
  })
})
