import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MIN_SUPPORTED_GITNEXUS_VERSION,
  loadConfig,
  gitnexusCmd,
  buildAnalyzeArgs,
  parseSemVer,
  compareSemVer,
  isVersionSupported,
  isValidGitnexusVersion,
  checkGitNexusCliCompatibility,
} from "../src/config.js"
import { isGitNexusCliAvailable } from "../src/index.js"

describe("loadConfig & Security Trust Boundary (SEC-001, SEC-002)", () => {
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
    assert.equal(cfg.autoRefreshStale, true)
    assert.equal(cfg.autoRefreshOnCommit, true)
    assert.equal(cfg.allowNpxFallback, false)
    assert.equal(cfg.indexOnly, true)
    assert.equal(cfg.gitnexusVersion, MIN_SUPPORTED_GITNEXUS_VERSION)
  })

  it("allows project config to override non-security preferences only", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ autoRefreshStale: false, autoRefreshOnCommit: false }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.autoRefreshStale, false)
    assert.equal(cfg.autoRefreshOnCommit, false)
    assert.equal(cfg.allowNpxFallback, false)
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
    assert.equal(cfg.allowNpxFallback, false)
    assert.equal(cfg.indexOnly, true)
  })

  it("SEC-001: repository config setting allowNpxFallback: true CANNOT enable npx", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({
        allowNpxFallback: true,
        gitnexusVersion: "npm:attacker-package@1.0.0",
      }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.allowNpxFallback, false)
    assert.equal(cfg.gitnexusVersion, MIN_SUPPORTED_GITNEXUS_VERSION)
  })

  it("SEC-001: repository config cannot override gitnexusVersion even with valid SemVer", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ gitnexusVersion: "2.0.0" }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.gitnexusVersion, MIN_SUPPORTED_GITNEXUS_VERSION)
  })

  it("SEC-001: user-level global config can explicitly authorize allowNpxFallback and valid SemVer", () => {
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ allowNpxFallback: true, gitnexusVersion: "1.7.0" }),
    )
    const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
    assert.equal(cfg.allowNpxFallback, true)
    assert.equal(cfg.gitnexusVersion, "1.7.0")
  })

  it("SEC-001: rejects malicious package sources in global config and falls back to pinned version", () => {
    const maliciousSources = [
      "npm:attacker-package@1.0.0",
      "git+https://evil.example/repo.git",
      "git://evil.example/repo.git",
      "github:attacker/gitnexus",
      "file:/tmp/attacker.tgz",
      "https://evil.example/gitnexus-1.0.0.tgz",
      "http://evil.example/pkg.tar.gz",
      "1.6.12 --registry=https://evil.example",
      "../local-dir",
      "1.5.2",
      "latest",
    ]
    for (const source of maliciousSources) {
      writeFileSync(
        globalConfigPath,
        JSON.stringify({ allowNpxFallback: true, gitnexusVersion: source }),
      )
      const cfg = loadConfig(tmpProject, { globalConfigPath, env: {} })
      assert.equal(
        cfg.gitnexusVersion,
        MIN_SUPPORTED_GITNEXUS_VERSION,
        `expected malicious/unsupported version "${source}" to be rejected`,
      )
    }
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

describe("gitnexusCmd & Package Source Validation (SEC-001)", () => {
  const noLocalBinEnv = { GITNEXUS_DISABLE_LOCAL_BIN: "1", PATH: "" }

  it("resolves local binary from GITNEXUS_BIN when present", () => {
    const cmd = gitnexusCmd(
      {
        gitnexusVersion: "1.6.12",
        allowNpxFallback: false,
      },
      { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
    )
    assert.deepEqual(cmd, ["/usr/local/bin/gitnexus"])
  })

  it("fails safely (throws) when local binary is missing and allowNpxFallback is false (default)", () => {
    assert.throws(
      () =>
        gitnexusCmd(
          {
            gitnexusVersion: "1.6.12",
            allowNpxFallback: false,
          },
          noLocalBinEnv,
        ),
      /allowNpxFallback is disabled/,
    )
  })

  it("returns restricted npx command ONLY when user explicitly authorizes allowNpxFallback with valid SemVer", () => {
    const cmd = gitnexusCmd(
      {
        gitnexusVersion: "1.6.12",
        allowNpxFallback: true,
      },
      noLocalBinEnv,
    )
    assert.deepEqual(cmd, ["npx", "-y", "gitnexus@1.6.12"])
  })

  it("rejects npm alias, Git URL, file URL, tarball URL, old version, and 'latest' in gitnexusCmd", () => {
    const invalidSpecs = [
      "npm:attacker-package@1.0.0",
      "git+https://evil.example/pkg.git",
      "file:/tmp/evil.tgz",
      "https://evil.example/evil.tgz",
      "1.6.12 --registry=https://evil.example",
      "1.5.2",
      "latest",
    ]
    for (const spec of invalidSpecs) {
      assert.equal(isValidGitnexusVersion(spec), false, `expected ${spec} to be invalid`)
      assert.throws(
        () =>
          gitnexusCmd(
            {
              gitnexusVersion: spec,
              allowNpxFallback: true,
            },
            noLocalBinEnv,
          ),
        /Invalid or unsupported|Refusing to execute npx/i,
      )
    }
  })
})

describe("Version Compatibility & Capability Detection (COMP-001)", () => {
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
    const res = checkGitNexusCliCompatibility(
      { indexOnly: true },
      {
        env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
        execRunner: (_file, args) => {
          if (args[0] === "--version") return "1.6.12\n"
          if (args[0] === "analyze" && args[1] === "--help") {
            return "Usage: gitnexus analyze [options]\n  --index-only  Skip AGENTS.md/CLAUDE.md injection\n"
          }
          return ""
        },
      },
    )
    assert.equal(res.compatible, true)
    assert.equal(res.version, "1.6.12")
    assert.equal(res.supportsIndexOnly, true)
  })

  it("identifies and rejects old CLI versions (< 1.6.12) with a clear error message", () => {
    const cfg = {
      autoIndex: true,
      autoRefreshStale: true,
      autoRefreshOnCommit: true,
      gitnexusVersion: "1.6.12",
      HintTools: [],
      allowNpxFallback: false,
      indexOnly: true,
    }
    const res = checkGitNexusCliCompatibility(cfg, {
      env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
      execRunner: (_file, args) => {
        if (args[0] === "--version") return "1.5.2\n"
        return ""
      },
    })
    assert.equal(res.compatible, false)
    assert.equal(res.version, "1.5.2")
    assert.match(res.reason ?? "", /Minimum supported version is 1\.6\.12/)
    // COMP-001: Failure must never disable indexOnly security mode
    assert.equal(cfg.indexOnly, true)
  })

  it("reports clearly when CLI does not support --index-only", () => {
    const res = checkGitNexusCliCompatibility(
      { indexOnly: true },
      {
        env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
        execRunner: (_file, args) => {
          if (args[0] === "--version") return "1.6.12\n"
          if (args[0] === "analyze" && args[1] === "--help") {
            return "Usage: gitnexus analyze [options]\n  --embeddings  Enable embeddings\n"
          }
          return ""
        },
      },
    )
    assert.equal(res.compatible, false)
    assert.equal(res.supportsIndexOnly, false)
    assert.match(res.reason ?? "", /--index-only/)
  })

  it("fails safely on malformed version output without disabling indexOnly", () => {
    const cfg = {
      autoIndex: true,
      autoRefreshStale: true,
      autoRefreshOnCommit: true,
      gitnexusVersion: "1.6.12",
      HintTools: [],
      allowNpxFallback: false,
      indexOnly: true,
    }
    const res = checkGitNexusCliCompatibility(cfg, {
      env: { GITNEXUS_BIN: "/usr/local/bin/gitnexus" },
      execRunner: () => "gitnexus-custom-dev-build\n",
    })
    assert.equal(res.compatible, false)
    assert.match(res.reason ?? "", /Malformed GitNexus CLI version output/)
    assert.equal(cfg.indexOnly, true)
  })

  it("SEC-001 & COMP-001: never invokes npx or network download during CLI availability check when binary is missing", () => {
    let runnerCalled = false
    const cfg = {
      autoIndex: true,
      autoRefreshStale: true,
      autoRefreshOnCommit: true,
      gitnexusVersion: "1.6.12",
      HintTools: [],
      allowNpxFallback: true,
      indexOnly: true,
    }
    const available = isGitNexusCliAvailable(cfg, {
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
