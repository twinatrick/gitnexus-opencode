import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import {
  loadConfig,
  getDeprecatedConfigKeys,
  resolveLocalGitnexusBin,
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

function createExecutable(filePath: string, body = "#!/bin/sh\nexit 0\n"): string {
  writeFileSync(filePath, body)
  chmodSync(filePath, 0o755)
  return filePath
}

describe("gitnexusCmd: local-binary-only execution (SEC-004, SEC-005)", () => {
  const noLocalBinEnv = { GITNEXUS_DISABLE_LOCAL_BIN: "1", PATH: "" }
  let tmpBinDir: string
  let trustedBin: string

  beforeEach(() => {
    tmpBinDir = mkdtempSync(join(tmpdir(), "gitnexus-trusted-bin-"))
    trustedBin = createExecutable(join(tmpBinDir, "gitnexus"))
  })

  afterEach(() => {
    rmSync(tmpBinDir, { recursive: true, force: true })
  })

  it("resolves local binary from a validated GITNEXUS_BIN when present", () => {
    const cmd = gitnexusCmd({ GITNEXUS_BIN: trustedBin })
    assert.deepEqual(cmd, [realpathSync(trustedBin)])
  })

  it("fails safely with an actionable message when no local binary exists", () => {
    assert.throws(
      () => gitnexusCmd(noLocalBinEnv),
      /never downloads packages via npm\/npx/,
    )
    assert.throws(
      () => gitnexusCmd(noLocalBinEnv),
      /Install gitnexus >= 1\.6\.12|GITNEXUS_BIN/,
    )
  })

  it("GITNEXUS_DISABLE_LOCAL_BIN takes precedence over GITNEXUS_BIN", () => {
    assert.throws(() =>
      gitnexusCmd({
        GITNEXUS_DISABLE_LOCAL_BIN: "1",
        GITNEXUS_BIN: trustedBin,
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

describe("SEC-005: Untrusted PATH & Repository Binary Hijacking Prevention", () => {
  let tmpRoot: string
  let repoDir: string
  let trustedBinDir: string
  let markerPath: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gitnexus-sec005-"))
    repoDir = join(tmpRoot, "untrusted-repo")
    trustedBinDir = join(tmpRoot, "trusted-bin")
    markerPath = join(tmpRoot, "hijack-executed.log")
    mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true })
    mkdirSync(trustedBinDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("rejects relative PATH entries such as '.' even when ./gitnexus exists", () => {
    const evilBin = createExecutable(
      join(repoDir, "gitnexus"),
      `#!/bin/sh\necho pwned >> "${markerPath}"\nexit 0\n`,
    )
    assert.ok(existsSync(evilBin))

    const resolved = resolveLocalGitnexusBin(
      { PATH: [".", "./bin", "../untrusted-repo"].join(delimiter) },
      { worktree: repoDir },
    )
    assert.equal(resolved, null)
    assert.equal(existsSync(markerPath), false)
  })

  it("rejects PATH entries inside node_modules/.bin", () => {
    const nmBinDir = join(repoDir, "node_modules", ".bin")
    createExecutable(
      join(nmBinDir, "gitnexus"),
      `#!/bin/sh\necho pwned >> "${markerPath}"\nexit 0\n`,
    )

    const externalNmDir = join(tmpRoot, "external", "node_modules", ".bin")
    mkdirSync(externalNmDir, { recursive: true })
    createExecutable(
      join(externalNmDir, "gitnexus"),
      `#!/bin/sh\necho pwned >> "${markerPath}"\nexit 0\n`,
    )

    const resolved = resolveLocalGitnexusBin(
      { PATH: [nmBinDir, externalNmDir].join(delimiter) },
      { worktree: repoDir },
    )
    assert.equal(resolved, null)
    assert.equal(existsSync(markerPath), false)
  })

  it("never executes a malicious 'which' binary placed on PATH", () => {
    const evilRepoBin = createExecutable(
      join(repoDir, "gitnexus"),
      `#!/bin/sh\necho repo-bin >> "${markerPath}"\nexit 0\n`,
    )
    createExecutable(
      join(trustedBinDir, "which"),
      `#!/bin/sh\necho which-hijack >> "${markerPath}"\nprintf '%s\\n' "${evilRepoBin}"\nexit 0\n`,
    )

    const resolved = resolveLocalGitnexusBin(
      { PATH: trustedBinDir },
      { worktree: repoDir },
    )
    assert.equal(resolved, null)
    assert.equal(existsSync(markerPath), false)
  })

  it("never executes a malicious 'where' binary placed on PATH", () => {
    const evilRepoBin = createExecutable(
      join(repoDir, "gitnexus"),
      `#!/bin/sh\necho repo-bin >> "${markerPath}"\nexit 0\n`,
    )
    createExecutable(
      join(trustedBinDir, "where"),
      `#!/bin/sh\necho where-hijack >> "${markerPath}"\nprintf '%s\\n' "${evilRepoBin}"\nexit 0\n`,
    )

    const resolved = resolveLocalGitnexusBin(
      { PATH: trustedBinDir },
      { worktree: repoDir },
    )
    assert.equal(resolved, null)
    assert.equal(existsSync(markerPath), false)
  })

  it("rejects a symlink in a trusted PATH directory that resolves into the repository", () => {
    const evilRepoBin = createExecutable(
      join(repoDir, "evil-gitnexus"),
      `#!/bin/sh\necho symlink-hijack >> "${markerPath}"\nexit 0\n`,
    )
    const symlinkBin = join(trustedBinDir, "gitnexus")
    symlinkSync(evilRepoBin, symlinkBin)

    const resolved = resolveLocalGitnexusBin(
      { PATH: trustedBinDir },
      { worktree: repoDir },
    )
    assert.equal(resolved, null)
    assert.equal(existsSync(markerPath), false)
  })

  it("rejects GITNEXUS_BIN when relative, inside the repository, or a symlink into the repository", () => {
    const evilRepoBin = createExecutable(
      join(repoDir, "evil-gitnexus"),
      `#!/bin/sh\necho gitnexus-bin-hijack >> "${markerPath}"\nexit 0\n`,
    )
    const symlinkBin = join(trustedBinDir, "gitnexus-link")
    symlinkSync(evilRepoBin, symlinkBin)

    assert.equal(
      resolveLocalGitnexusBin({ GITNEXUS_BIN: "./gitnexus" }, { worktree: repoDir }),
      null,
    )
    assert.equal(
      resolveLocalGitnexusBin({ GITNEXUS_BIN: evilRepoBin }, { worktree: repoDir }),
      null,
    )
    assert.equal(
      resolveLocalGitnexusBin({ GITNEXUS_BIN: symlinkBin }, { worktree: repoDir }),
      null,
    )
    assert.equal(existsSync(markerPath), false)
  })

  it("accepts a trusted GITNEXUS_BIN outside the repository and returns its canonical realpath", () => {
    const realBin = createExecutable(join(trustedBinDir, "gitnexus-real"))
    const linkInTrusted = join(trustedBinDir, "gitnexus")
    symlinkSync(realBin, linkInTrusted)

    const resolved = resolveLocalGitnexusBin(
      { GITNEXUS_BIN: linkInTrusted },
      { worktree: repoDir },
    )
    assert.equal(resolved, realpathSync(realBin))
  })

  it("compatibility check never executes an untrusted repository binary", () => {
    const evilRepoBin = createExecutable(
      join(repoDir, "gitnexus"),
      `#!/bin/sh\necho compat-pwned >> "${markerPath}"\necho "1.6.12"\n`,
    )
    const nmBin = createExecutable(
      join(repoDir, "node_modules", ".bin", "gitnexus"),
      `#!/bin/sh\necho nm-pwned >> "${markerPath}"\necho "1.6.12"\n`,
    )
    assert.ok(existsSync(evilRepoBin))
    assert.ok(existsSync(nmBin))

    let runnerCalled = false
    const compat = checkGitNexusCliCompatibility({
      env: {
        PATH: [".", repoDir, join(repoDir, "node_modules", ".bin")].join(delimiter),
      },
      worktree: repoDir,
      execRunner: () => {
        runnerCalled = true
        return "1.6.12\n"
      },
    })
    assert.equal(compat.compatible, false)
    assert.equal(compat.binary, null)
    assert.equal(runnerCalled, false)
    assert.equal(existsSync(markerPath), false)
  })
})

describe("Version Compatibility & Capability Detection (COMP-001, SEC-004, SEC-005)", () => {
  let tmpBinDir: string
  let trustedBin: string

  beforeEach(() => {
    tmpBinDir = mkdtempSync(join(tmpdir(), "gitnexus-compat-bin-"))
    trustedBin = createExecutable(join(tmpBinDir, "gitnexus"))
  })

  afterEach(() => {
    rmSync(tmpBinDir, { recursive: true, force: true })
  })

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
      env: { GITNEXUS_BIN: trustedBin },
      execRunner: (_file, args) => {
        if (args[0] === "--version") return "1.6.12\n"
        if (args[0] === "analyze" && args[1] === "--help") {
          return "Usage: gitnexus analyze [options]\n  --index-only  Skip AGENTS.md/CLAUDE.md injection\n"
        }
        return ""
      },
    })
    assert.equal(res.compatible, true)
    assert.equal(res.binary, realpathSync(trustedBin))
    assert.equal(res.version, "1.6.12")
    assert.equal(res.supportsIndexOnly, true)
  })

  it("identifies and rejects old CLI versions (< 1.6.12) with a clear error message", () => {
    const res = checkGitNexusCliCompatibility({
      env: { GITNEXUS_BIN: trustedBin },
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
      env: { GITNEXUS_BIN: trustedBin },
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
      env: { GITNEXUS_BIN: trustedBin },
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
