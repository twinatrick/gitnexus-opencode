import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export const MIN_SUPPORTED_GITNEXUS_VERSION = "1.6.12";

export interface PluginConfig {
  autoIndex: boolean;
  autoRefreshStale: boolean;
  autoRefreshOnCommit: boolean;
  gitnexusVersion: string;
  HintTools: string[];
  allowNpxFallback: boolean;
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

const DEFAULTS: PluginConfig = {
  autoIndex: true,
  autoRefreshStale: true,
  autoRefreshOnCommit: true,
  gitnexusVersion: MIN_SUPPORTED_GITNEXUS_VERSION,
  HintTools: ["grep", "glob", "read", "bash"],
  allowNpxFallback: false,
  indexOnly: true,
};

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

/**
 * Validates that a version string is a canonical SemVer >= MIN_SUPPORTED_GITNEXUS_VERSION
 * and rejects untrusted package sources (npm aliases, Git URLs, file URLs, tarball URLs,
 * path traversal, registry flags, or whitespace injection).
 */
export function isValidGitnexusVersion(version: unknown): version is string {
  if (typeof version !== "string") return false;
  if (version !== version.trim() || version.length === 0) return false;
  const lower = version.toLowerCase();
  if (
    lower.startsWith("npm:") ||
    lower.startsWith("git+") ||
    lower.startsWith("git:") ||
    lower.startsWith("github:") ||
    lower.startsWith("file:") ||
    lower.startsWith("http:") ||
    lower.startsWith("https:") ||
    lower.includes("://") ||
    lower.includes("/") ||
    lower.includes("\\") ||
    lower.includes("..") ||
    lower.includes("@") ||
    lower.includes("--") ||
    /\s/.test(version) ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar.gz")
  ) {
    return false;
  }
  if (!STRICT_SEMVER_RE.test(version)) return false;
  return isVersionSupported(version, MIN_SUPPORTED_GITNEXUS_VERSION);
}

export function loadConfig(worktree?: string, options?: LoadConfigOptions): PluginConfig {
  const env = options?.env ?? process.env;
  const globalPath =
    options?.globalConfigPath ?? join(homedir(), ".config", "opencode", "gitnexus-opencode.json");
  const projectPath = worktree ? join(worktree, ".opencode", "gitnexus-opencode.json") : null;

  const globalCfg = readJsonSafe(globalPath) ?? {};
  const projectCfg = projectPath ? (readJsonSafe(projectPath) ?? {}) : {};
  const mergedNonSecurity = { ...globalCfg, ...projectCfg };

  // SEC-001: allowNpxFallback and gitnexusVersion are strictly user-level security settings.
  // Untrusted repository configs (.opencode/gitnexus-opencode.json) must never control
  // package execution sources or enable npx network downloads.
  const allowNpxFallback =
    typeof globalCfg.allowNpxFallback === "boolean"
      ? globalCfg.allowNpxFallback
      : env.GITNEXUS_ALLOW_NPX_FALLBACK === "1";

  const gitnexusVersion = isValidGitnexusVersion(globalCfg.gitnexusVersion)
    ? globalCfg.gitnexusVersion
    : DEFAULTS.gitnexusVersion;

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
    gitnexusVersion,
    HintTools: Array.isArray(mergedNonSecurity.HintTools)
      ? (mergedNonSecurity.HintTools as unknown[]).filter((t): t is string => typeof t === "string")
      : DEFAULTS.HintTools,
    allowNpxFallback,
    indexOnly,
  };
}

export function resolveLocalGitnexusBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GITNEXUS_DISABLE_LOCAL_BIN === "1") {
    return null;
  }
  if (env.GITNEXUS_BIN && env.GITNEXUS_BIN.trim().length > 0) {
    return env.GITNEXUS_BIN.trim();
  }
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["gitnexus"], {
      encoding: "utf-8",
      timeout: 3000,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

export function gitnexusCmd(
  cfg: Partial<PluginConfig> & Pick<PluginConfig, "gitnexusVersion">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const localBin = resolveLocalGitnexusBin(env);
  if (localBin) {
    return [localBin];
  }
  if (cfg.allowNpxFallback === true) {
    if (!isValidGitnexusVersion(cfg.gitnexusVersion)) {
      throw new Error(
        `Refusing to execute npx with invalid or unsupported gitnexusVersion "${String(cfg.gitnexusVersion)}". ` +
          `Expected canonical SemVer >= ${MIN_SUPPORTED_GITNEXUS_VERSION}.`,
      );
    }
    return ["npx", "-y", `gitnexus@${cfg.gitnexusVersion}`];
  }
  throw new Error(
    "Local gitnexus binary not found on PATH (or GITNEXUS_BIN), and allowNpxFallback is disabled by security policy.",
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
 * COMP-001 & SEC-001: Validates local GitNexus CLI availability, SemVer >= MIN_SUPPORTED_GITNEXUS_VERSION,
 * and `--index-only` capability without ever triggering npx network downloads.
 */
export function checkGitNexusCliCompatibility(
  _config?: Partial<PluginConfig>,
  options?: { env?: NodeJS.ProcessEnv; execRunner?: CliRunner },
): CliCompatibilityResult {
  const env = options?.env ?? process.env;
  const runner = options?.execRunner ?? defaultCliRunner;

  const localBin = resolveLocalGitnexusBin(env);
  if (!localBin) {
    return {
      compatible: false,
      binary: null,
      version: null,
      supportsIndexOnly: false,
      reason:
        "Local gitnexus CLI binary not found. Automatic network download (npx) is disabled during CLI check.",
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
