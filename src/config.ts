import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

export const MIN_SUPPORTED_GITNEXUS_VERSION = "1.6.12";

export interface PluginConfig {
  autoIndex: boolean;
  autoRefreshStale: boolean;
  autoRefreshOnCommit: boolean;
  HintTools: string[];
  indexOnly: boolean;
}

export interface LoadConfigOptions {
  globalConfigPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface CliCompatibilityResult {
  compatible: boolean;
  binary: string | null;
  version: string | null;
  supportsIndexOnly: boolean;
  reason?: string;
}

export type CliRunner = (file: string, args: string[]) => string;

export interface ResolveBinaryOptions {
  /**
   * Untrusted workspace/repository directory. Any binary located inside this
   * directory (directly or via symlink resolution) is rejected (SEC-005).
   */
  worktree?: string;
}

const DEFAULTS: PluginConfig = {
  autoIndex: true,
  autoRefreshStale: true,
  autoRefreshOnCommit: true,
  HintTools: ["grep", "glob", "read", "bash"],
  indexOnly: true,
};

/**
 * SEC-004: `allowNpxFallback` and `gitnexusVersion` used to control an npm/npx
 * download path. The plugin now never invokes a package manager, so these keys
 * are ignored in both user-level and repository-level config.
 */
const LEGACY_PACKAGE_KEYS = ["allowNpxFallback", "gitnexusVersion"] as const;

const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

const CLI_VERSION_OUTPUT_RE =
  /^(?:gitnexus(?:\s+cli)?\s+)?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i;

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseSemVer(raw: unknown): SemVer | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const normalized = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const match = STRICT_SEMVER_RE.exec(normalized);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: match[4],
  };
}

export function compareSemVer(a: SemVer | string, b: SemVer | string): number {
  const parsedA = typeof a === "string" ? parseSemVer(a) : a;
  const parsedB = typeof b === "string" ? parseSemVer(b) : b;
  if (!parsedA || !parsedB) {
    throw new Error("Cannot compare invalid SemVer values");
  }

  if (parsedA.major !== parsedB.major) return parsedA.major > parsedB.major ? 1 : -1;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor > parsedB.minor ? 1 : -1;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch > parsedB.patch ? 1 : -1;

  if (!parsedA.prerelease && !parsedB.prerelease) return 0;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && !parsedB.prerelease) return -1;

  const partsA = parsedA.prerelease!.split(".");
  const partsB = parsedB.prerelease!.split(".");
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const idA = partsA[i];
    const idB = partsB[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    if (idA === idB) continue;

    const numA = /^\d+$/.test(idA) ? Number(idA) : NaN;
    const numB = /^\d+$/.test(idB) ? Number(idB) : NaN;
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      return numA > numB ? 1 : -1;
    }
    if (!Number.isNaN(numA)) return -1;
    if (!Number.isNaN(numB)) return 1;
    return idA > idB ? 1 : -1;
  }
  return 0;
}

export function isVersionSupported(
  version: unknown,
  minVersion: string = MIN_SUPPORTED_GITNEXUS_VERSION,
): boolean {
  const parsedVersion = parseSemVer(version);
  const parsedMin = parseSemVer(minVersion);
  if (!parsedVersion || !parsedMin) return false;
  return compareSemVer(parsedVersion, parsedMin) >= 0;
}

function resolveConfigPaths(worktree?: string, options?: LoadConfigOptions) {
  return {
    globalPath:
      options?.globalConfigPath ??
      join(homedir(), ".config", "opencode", "gitnexus-opencode.json"),
    projectPath: worktree ? join(worktree, ".opencode", "gitnexus-opencode.json") : null,
  };
}

export interface DeprecatedConfigWarning {
  scope: "user" | "repository";
  keys: string[];
}

/**
 * SEC-004: Reports legacy package-execution keys so the plugin can warn once at
 * startup. The keys are never honored — the plugin has no npm/npx code path.
 */
export function getDeprecatedConfigKeys(
  worktree?: string,
  options?: LoadConfigOptions,
): DeprecatedConfigWarning[] {
  const { globalPath, projectPath } = resolveConfigPaths(worktree, options);
  const warnings: DeprecatedConfigWarning[] = [];

  const globalCfg = readJsonSafe(globalPath) ?? {};
  const globalKeys = LEGACY_PACKAGE_KEYS.filter((key) => key in globalCfg);
  if (globalKeys.length > 0) {
    warnings.push({ scope: "user", keys: [...globalKeys] });
  }

  if (projectPath) {
    const projectCfg = readJsonSafe(projectPath) ?? {};
    const projectKeys = LEGACY_PACKAGE_KEYS.filter((key) => key in projectCfg);
    if (projectKeys.length > 0) {
      warnings.push({ scope: "repository", keys: [...projectKeys] });
    }
  }

  return warnings;
}

export function loadConfig(worktree?: string, options?: LoadConfigOptions): PluginConfig {
  const { globalPath, projectPath } = resolveConfigPaths(worktree, options);

  const globalCfg = readJsonSafe(globalPath) ?? {};
  const projectCfg = projectPath ? (readJsonSafe(projectPath) ?? {}) : {};
  const mergedNonSecurity = { ...globalCfg, ...projectCfg };

  // SEC-002: indexOnly defaults to true and cannot be disabled by repository config.
  // Only user-level config can explicitly opt out (indexOnly: false).
  // Repository config may only reinforce indexOnly: true.
  const userIndexOnly =
    typeof globalCfg.indexOnly === "boolean" ? globalCfg.indexOnly : DEFAULTS.indexOnly;
  const indexOnly = projectCfg.indexOnly === true ? true : userIndexOnly;

  return {
    autoIndex:
      typeof mergedNonSecurity.autoIndex === "boolean"
        ? mergedNonSecurity.autoIndex
        : DEFAULTS.autoIndex,
    autoRefreshStale:
      typeof mergedNonSecurity.autoRefreshStale === "boolean"
        ? mergedNonSecurity.autoRefreshStale
        : DEFAULTS.autoRefreshStale,
    autoRefreshOnCommit:
      typeof mergedNonSecurity.autoRefreshOnCommit === "boolean"
        ? mergedNonSecurity.autoRefreshOnCommit
        : DEFAULTS.autoRefreshOnCommit,
    HintTools: Array.isArray(mergedNonSecurity.HintTools)
      ? (mergedNonSecurity.HintTools as unknown[]).filter((t): t is string => typeof t === "string")
      : DEFAULTS.HintTools,
    indexOnly,
  };
}

function hasNodeModulesSegment(p: string): boolean {
  return /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(p);
}

function hasNodeModulesBinSegment(p: string): boolean {
  return /(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/.test(p);
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectUntrustedRoots(worktree?: string): string[] {
  const roots = new Set<string>();
  const addRoot = (raw?: string) => {
    if (!raw || !raw.trim()) return;
    const resolved = resolve(raw.trim());
    roots.add(resolved);
    try {
      roots.add(realpathSync(resolved));
    } catch {
      // Directory may not exist yet in synthetic tests.
    }
  };

  if (worktree && worktree.trim().length > 0) {
    addRoot(worktree);
  } else {
    const cwd = process.cwd();
    if (!isPathInside(tmpdir(), cwd)) {
      addRoot(cwd);
    }
  }
  return [...roots];
}

function validateExecutableFile(
  candidatePath: string,
  untrustedRoots: string[],
): string | null {
  if (!isAbsolute(candidatePath)) return null;
  if (/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(candidatePath)) return null;

  const normalizedCandidate = resolve(candidatePath);
  if (hasNodeModulesBinSegment(normalizedCandidate)) return null;
  if (untrustedRoots.some((root) => isPathInside(normalizedCandidate, root))) {
    return null;
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync(normalizedCandidate);
  } catch {
    return null;
  }

  if (hasNodeModulesBinSegment(realCandidate)) return null;
  if (untrustedRoots.some((root) => isPathInside(realCandidate, root))) {
    return null;
  }

  try {
    const st = statSync(realCandidate);
    if (!st.isFile()) return null;
    if (process.platform !== "win32") {
      accessSync(realCandidate, constants.X_OK);
    }
  } catch {
    return null;
  }

  return realCandidate;
}

/**
 * SEC-005: Resolves a trusted local GitNexus CLI binary using Node.js
 * filesystem APIs only (never invokes `which` or `where`).
 *
 * Security invariants:
 * - Honors explicit `GITNEXUS_BIN` first, requiring an existing executable at an
 *   absolute path whose canonical realpath is outside the repository/worktree.
 * - Rejects relative PATH entries (e.g. `.`, `./bin`).
 * - Rejects PATH entries inside `node_modules` (e.g. `node_modules/.bin`).
 * - Rejects binaries inside the repository/worktree or symlinks resolving into it.
 * - Returns the canonical absolute `realpath` of the validated executable.
 */
export function resolveLocalGitnexusBin(
  env: NodeJS.ProcessEnv = process.env,
  options?: ResolveBinaryOptions,
): string | null {
  if (env.GITNEXUS_DISABLE_LOCAL_BIN === "1") {
    return null;
  }

  const untrustedRoots = collectUntrustedRoots(options?.worktree);

  if (env.GITNEXUS_BIN && env.GITNEXUS_BIN.trim().length > 0) {
    return validateExecutableFile(env.GITNEXUS_BIN.trim(), untrustedRoots);
  }

  const rawPath = env.PATH ?? "";
  if (!rawPath) return null;

  const candidateNames =
    process.platform === "win32"
      ? ["gitnexus.exe", "gitnexus.cmd", "gitnexus.bat", "gitnexus"]
      : ["gitnexus"];

  for (const rawEntry of rawPath.split(delimiter)) {
    const dir = rawEntry.trim();
    if (!dir) continue;
    if (!isAbsolute(dir)) continue;
    if (/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(dir)) continue;
    if (hasNodeModulesSegment(dir)) continue;

    const resolvedDir = resolve(dir);
    if (untrustedRoots.some((root) => isPathInside(resolvedDir, root))) continue;

    let realDir: string;
    try {
      realDir = realpathSync(resolvedDir);
    } catch {
      continue;
    }
    if (hasNodeModulesSegment(realDir)) continue;
    if (untrustedRoots.some((root) => isPathInside(realDir, root))) continue;

    for (const exeName of candidateNames) {
      const validated = validateExecutableFile(
        join(resolvedDir, exeName),
        untrustedRoots,
      );
      if (validated) return validated;
    }
  }

  return null;
}

/**
 * SEC-004 & SEC-005: Resolves a validated local execution command for the
 * GitNexus CLI.
 *
 * The plugin deliberately has no package-manager fallback and never trusts
 * relative PATH entries, `node_modules/.bin`, or repository-controlled binaries.
 */
export function gitnexusCmd(
  env: NodeJS.ProcessEnv = process.env,
  options?: ResolveBinaryOptions,
): string[] {
  const localBin = resolveLocalGitnexusBin(env, options);
  if (localBin) {
    return [localBin];
  }
  throw new Error(
    "Local gitnexus binary not found on a trusted PATH (or GITNEXUS_BIN). " +
      "This plugin never downloads packages via npm/npx and rejects untrusted repository binaries. " +
      `Install gitnexus >= ${MIN_SUPPORTED_GITNEXUS_VERSION} in a trusted local directory, or point GITNEXUS_BIN at its absolute path.`,
  );
}

export function buildAnalyzeArgs(
  repoPath: string,
  cfg: Pick<PluginConfig, "indexOnly">,
): string[] {
  return cfg.indexOnly !== false ? ["analyze", "--index-only", repoPath] : ["analyze", repoPath];
}

function defaultCliRunner(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * COMP-001, SEC-004 & SEC-005: Validates local GitNexus CLI availability,
 * SemVer >= MIN_SUPPORTED_GITNEXUS_VERSION, and `--index-only` capability
 * against a single canonical binary path (preventing TOCTOU re-resolution).
 */
export function checkGitNexusCliCompatibility(options?: {
  env?: NodeJS.ProcessEnv;
  worktree?: string;
  execRunner?: CliRunner;
}): CliCompatibilityResult {
  const env = options?.env ?? process.env;
  const runner = options?.execRunner ?? defaultCliRunner;

  const localBin = resolveLocalGitnexusBin(env, { worktree: options?.worktree });
  if (!localBin) {
    return {
      compatible: false,
      binary: null,
      version: null,
      supportsIndexOnly: false,
      reason:
        "Local gitnexus CLI binary not found. This plugin never downloads packages; install gitnexus locally or set GITNEXUS_BIN.",
    };
  }

  let rawVersionOutput = "";
  try {
    rawVersionOutput = runner(localBin, ["--version"]).trim();
  } catch (err) {
    return {
      compatible: false,
      binary: localBin,
      version: null,
      supportsIndexOnly: false,
      reason: `Failed to execute "${localBin} --version": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const firstLine = rawVersionOutput.split(/\r?\n/)[0]?.trim() ?? "";
  const versionMatch = CLI_VERSION_OUTPUT_RE.exec(firstLine);
  const extractedVersion = versionMatch ? versionMatch[1]! : null;
  const parsedVersion = extractedVersion ? parseSemVer(extractedVersion) : null;

  if (!extractedVersion || !parsedVersion) {
    return {
      compatible: false,
      binary: localBin,
      version: null,
      supportsIndexOnly: false,
      reason: `Malformed GitNexus CLI version output "${firstLine}". Expected SemVer >= ${MIN_SUPPORTED_GITNEXUS_VERSION}.`,
    };
  }

  if (!isVersionSupported(extractedVersion, MIN_SUPPORTED_GITNEXUS_VERSION)) {
    return {
      compatible: false,
      binary: localBin,
      version: extractedVersion,
      supportsIndexOnly: false,
      reason: `Incompatible GitNexus CLI version ${extractedVersion}. Minimum supported version is ${MIN_SUPPORTED_GITNEXUS_VERSION} (requires --index-only support).`,
    };
  }

  try {
    const helpOutput = runner(localBin, ["analyze", "--help"]);
    if (!helpOutput.includes("--index-only")) {
      return {
        compatible: false,
        binary: localBin,
        version: extractedVersion,
        supportsIndexOnly: false,
        reason: `GitNexus CLI ${extractedVersion} does not advertise required "--index-only" capability in "analyze --help".`,
      };
    }
  } catch (err) {
    return {
      compatible: false,
      binary: localBin,
      version: extractedVersion,
      supportsIndexOnly: false,
      reason: `Failed to verify "--index-only" capability via "${localBin} analyze --help": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    compatible: true,
    binary: localBin,
    version: extractedVersion,
    supportsIndexOnly: true,
  };
}
