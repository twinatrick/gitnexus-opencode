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
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import plugin from "../src/index.js"

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

async function createHarness(repoDir: string): Promise<Harness> {
  const logs: TestLog[] = []
  const client = {
    app: {
      log: async (input: { body: TestLog }) => {
        logs.push(input.body)
      },
    },
    session: { list: async () => ({ data: [] }) },
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
})
