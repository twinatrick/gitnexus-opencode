import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  getDeprecatedConfigKeys,
  gitnexusCmd,
  buildAnalyzeArgs,
  parseSemVer,
  compareSemVer,
  isVersionSupported,
  checkGitNexusCliCompatibility,
} from "../src/config.js"
import { isGitNexusCliAvailable } from "../src/index.js"

describe("loadConfig & Security Trust Boundary (SEC-002, SEC-004)", () => {
  let tmpRoot: string
  let tmpProject: string
  let globalConfigPath: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gitnexus-test-"))
    tmpProject = join(tmpRoot, "repo")
    mkdirSync(join(tmpProject, ".opencode"), { recursive: true })
    globalConfigPath = join(tmpRoot, "user-config", "gitnexus-opencode.json")
    mkdirSync(join(tmpRoot, "user-config"), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("returns secure defaults when no config files exist", () => {
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.autoIndex, true)
    assert.equal(cfg.autoRefreshStale, true)
    assert.equal(cfg.autoRefreshOnCommit, true)
    assert.deepEqual(cfg.HintTools, ["grep", "glob", "read", "bash"])
    assert.equal(cfg.indexOnly, true)
    assert.equal("allowNpxFallback" in cfg, false)
    assert.equal("gitnexusVersion" in cfg, false)
  })

  it("allows project config to override non-security preferences only", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ autoRefreshStale: false, autoRefreshOnCommit: false, autoIndex: false }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.autoRefreshStale, false)
    assert.equal(cfg.autoRefreshOnCommit, false)
    assert.equal(cfg.autoIndex, false)
    assert.equal(cfg.indexOnly, true)
  })

  it("malformed config is silently ignored and secure defaults are preserved", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      "{ broken json",
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.autoRefreshStale, true)
    assert.equal(cfg.autoRefreshOnCommit, true)
    assert.equal(cfg.indexOnly, true)
  })

  it("SEC-004: repository config package keys are ignored and reported", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({
        allowNpxFallback: true,
        gitnexusVersion: "npm:attacker-package@1.0.0",
      }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal("allowNpxFallback" in cfg, false)
    assert.equal("gitnexusVersion" in cfg, false)
    assert.deepEqual(getDeprecatedConfigKeys(tmpProject, { globalConfigPath }), [
      { scope: "repository", keys: ["allowNpxFallback", "gitnexusVersion"] },
    ])
  })

  it("SEC-004: user-level package keys are ignored too and reported", () => {
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ allowNpxFallback: true, gitnexusVersion: "1.7.0" }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal("allowNpxFallback" in cfg, false)
    assert.equal("gitnexusVersion" in cfg, false)
    assert.deepEqual(getDeprecatedConfigKeys(tmpProject, { globalConfigPath }), [
      { scope: "user", keys: ["allowNpxFallback", "gitnexusVersion"] },
    ])
  })

  it("SEC-004: no deprecated-key warning when config is clean", () => {
    writeFileSync(globalConfigPath, JSON.stringify({ autoIndex: true }))
    assert.deepEqual(getDeprecatedConfigKeys(tmpProject, { globalConfigPath }), [])
  })

  it("SEC-002: repository config setting indexOnly: false CANNOT disable Pure Index Mode", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ indexOnly: false }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.indexOnly, true)
    assert.deepEqual(buildAnalyzeArgs("/repo", cfg), ["analyze", "--index-only", "/repo"])
  })

  it("SEC-002: repository config setting indexOnly: true works as expected", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ indexOnly: true }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.indexOnly, true)
  })

  it("SEC-002: user-level global config can explicitly authorize indexOnly: false", () => {
    writeFileSync(globalConfigPath, JSON.stringify({ indexOnly: false }))
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.indexOnly, false)
    assert.deepEqual(buildAnalyzeArgs("/repo", cfg), ["analyze", "/repo"])
  })

  it("SEC-002: repository config indexOnly: true still enforces indexOnly even if global is false", () => {
    writeFileSync(globalConfigPath, JSON.stringify({ indexOnly: false }))
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ indexOnly: true }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.indexOnly, true)
  })
})

describe("gitnexusCmd: local-binary-only execution (SEC-004)", () => {
  const noLocalBinEnv = { GITNEXUS_DISABLE_LOCAL_BIN: "1", PATH: "" }

  it("resolves local binary from GITNEXUS_BIN when present", () => {
    const cmd = gitnexusCmd({ GITNEXUS_BIN: "/usr/local/bin/gitnexus" })
    assert.deepEqual(cmd, ["/usr/local/bin/gitnexus"])
  })

  it("fails safely with an actionable message when no local binary exists", () => {
    assert.throws(
      () => gitnexusCmd(noLocalBinEnv),
      /never downloads packages via npm\/npx/,
    )
    assert.throws(
      () => gitnexusCmd(noLocalBinEnv),
      /Install gitnexus >= 1\.6\.12 locally|GITNEXUS_BIN/,
    )
  })

  it("GITNEXUS_DISABLE_LOCAL_BIN takes precedence over GITNEXUS_BIN", () => {
    assert.throws(() =>
      gitnexusCmd({
        GITNEXUS_DISABLE_LOCAL_BIN: "1",
        GITNEXUS_BIN: "/usr/local/bin/gitnexus",
      }),
    )
  })

  it("never returns a package-manager command, even with legacy-looking environment", () => {
    const env = {
      ...noLocalBinEnv,
      npm_config_registry: "https://attacker.example.com/",
      GITNEXUS_ALLOW_NPX_FALLBACK: "1",
    }
    assert.throws(() => gitnexusCmd(env))
  })
})

describe("Version Compatibility & Capability Detection (COMP-001, SEC-004)", () => {
  it("compares SemVer numerically rather than lexicographically", () => {
    assert.ok(compareSemVer("1.10.0", "1.6.12") > 0)
    assert.ok(compareSemVer("1.6.12", "1.6.12") === 0)
    assert.ok(compareSemVer("1.5.2", "1.6.12") < 0)
    assert.ok(compareSemVer("1.6.12", "1.6.12-alpha.1") > 0)
    assert.equal(isVersionSupported("1.6.12"), true)
    assert.equal(isVersionSupported("1.10.0"), true)
    assert.equal(isVersionSupported("1.5.2"), false)
    assert.equal(parseSemVer("not-a-version"), null)
  })

  it("accepts a supported local CLI version that advertises --index-only", () => {
    const res = checkGitNexusCliCompatibility({
      env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
      execRunner: (_file, args) => {
        if (args[0] === "--version") return "1.6.12\n"
        if (args[0] === "analyze" && args[1] === "--help") {
          return "Usage: gitnexus analyze [options]\n  --index-only  Skip AGENTS.md/CLAUDE.md injection\n"
        }
        return ""
      },
    })
    assert.equal(res.compatible, true)
    assert.equal(res.version, "1.6.12")
    assert.equal(res.supportsIndexOnly, true)
  })

  it("identifies and rejects old CLI versions (< 1.6.12) with a clear error message", () => {
    const res = checkGitNexusCliCompatibility({
      env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
      execRunner: (_file, args) => {
        if (args[0] === "--version") return "1.5.2\n"
        return ""
      },
    })
    assert.equal(res.compatible, false)
    assert.equal(res.version, "1.5.2")
    assert.match(res.reason ?? "", /Minimum supported version is 1\.6\.12/)
  })

  it("reports clearly when CLI does not support --index-only", () => {
    const res = checkGitNexusCliCompatibility({
      env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
      execRunner: (_file, args) => {
        if (args[0] === "--version") return "1.6.12\n"
        if (args[0] === "analyze" && args[1] === "--help") {
          return "Usage: gitnexus analyze [options]\n  --embeddings  Enable embeddings\n"
        }
        return ""
      },
    })
    assert.equal(res.compatible, false)
    assert.equal(res.supportsIndexOnly, false)
    assert.match(res.reason ?? "", /--index-only/)
  })

  it("fails safely on malformed version output", () => {
    const res = checkGitNexusCliCompatibility({
      env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
      execRunner: () => "gitnexus-custom-dev-build\n",
    })
    assert.equal(res.compatible, false)
    assert.match(res.reason ?? "", /Malformed GitNexus CLI version output/)
  })

  it("SEC-004 & COMP-001: never invokes a runner or download when binary is missing", () => {
    let runnerCalled = false
    const available = isGitNexusCliAvailable({
      env: { GITNEXUS_DISABLE_LOCAL_BIN: "1", PATH: "" },
      execRunner: () => {
        runnerCalled = true
        return "1.6.12"
      },
    })
    assert.equal(available, false)
    assert.equal(runnerCalled, false)
  })
})
