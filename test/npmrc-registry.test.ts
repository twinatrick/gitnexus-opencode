import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, getDeprecatedConfigKeys, gitnexusCmd } from "../src/config.js"

const ATTACKER_REGISTRY = "https://attacker.example.com/"

describe("SEC-004: repository .npmrc cannot control package sources", () => {
  let tmpRoot: string
  let repoDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gitnexus-npmrc-"))
    repoDir = join(tmpRoot, "repo")
    mkdirSync(join(repoDir, ".opencode"), { recursive: true })
    writeFileSync(join(repoDir, ".npmrc"), `registry=${ATTACKER_REGISTRY}\n`)
    writeFileSync(
      join(repoDir, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({
        allowNpxFallback: true,
        gitnexusVersion: "npm:attacker-package@1.0.0",
        indexOnly: false,
      }),
    )
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("loads config without any package-source fields", () => {
    const cfg = loadConfig(repoDir, {
      globalConfigPath: join(tmpRoot, "nonexistent-global.json"),
    })
    assert.equal("allowNpxFallback" in cfg, false)
    assert.equal("gitnexusVersion" in cfg, false)
    assert.deepEqual(getDeprecatedConfigKeys(repoDir, {
      globalConfigPath: join(tmpRoot, "nonexistent-global.json"),
    }), [
      { scope: "repository", keys: ["allowNpxFallback", "gitnexusVersion"] },
    ])
  })

  it("fails safely instead of consulting the malicious registry", () => {
    assert.throws(
      () =>
        gitnexusCmd({
          GITNEXUS_DISABLE_LOCAL_BIN: "1",
          PATH: "",
          npm_config_registry: ATTACKER_REGISTRY,
        }),
      /never downloads packages via npm\/npx/,
    )
  })

  it("returns only the local binary when one is present", () => {
    const binDir = join(tmpRoot, "trusted-bin")
    mkdirSync(binDir, { recursive: true })
    const trustedBin = join(binDir, "gitnexus")
    writeFileSync(trustedBin, "#!/bin/sh\nexit 0\n")
    chmodSync(trustedBin, 0o755)
    const cmd = gitnexusCmd({ GITNEXUS_BIN: trustedBin }, { worktree: repoDir })
    assert.deepEqual(cmd, [realpathSync(trustedBin)])
  })
})

describe("SEC-004: no package-manager process is ever spawned", () => {
  let tmpRoot: string
  let markerPath: string
  let originalPath: string | undefined

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gitnexus-shim-"))
    markerPath = join(tmpRoot, "spawned.log")
    const binDir = join(tmpRoot, "bin")
    mkdirSync(binDir, { recursive: true })
    for (const name of ["npx", "npm"]) {
      const script = join(binDir, name)
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$$" >> "${markerPath}"\nexit 0\n`)
      chmodSync(script, 0o755)
    }
    originalPath = process.env.PATH
    process.env.PATH = `${binDir}:/usr/bin:/bin`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("does not invoke npx/npm shims when the local binary is missing", () => {
    assert.throws(() =>
      gitnexusCmd({
        GITNEXUS_DISABLE_LOCAL_BIN: "1",
        PATH: process.env.PATH,
      }),
    )
    assert.equal(existsSync(markerPath), false)
  })
})

describe("SEC-004: source tree has no package-manager execution path", () => {
  const sources = ["config.ts", "index.ts", "hooks.ts"]

  for (const file of sources) {
    it(`${file} contains no quoted package-manager executable literal`, () => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf-8")
      assert.doesNotMatch(source, /["'`](?:npx|npm|pnpm|yarn|bunx)["'`]/)
    })
  }

  it("no source file pins a remote gitnexus package spec", () => {
    for (const file of sources) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf-8")
      assert.doesNotMatch(source, /gitnexus@\d/)
      assert.doesNotMatch(source, /--registry=/)
    }
  })

  it("SEC-005: no source file invokes external 'which' or 'where' binaries for PATH lookup", () => {
    for (const file of sources) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf-8")
      assert.doesNotMatch(source, /execFileSync\(\s*["'`](?:which|where)["'`]/)
      assert.doesNotMatch(source, /\? ["']where["'] : ["']which["']/)
    }
  })
})
