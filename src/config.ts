import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PluginConfig {
  autoIndex: boolean;
  autoRefreshStale: boolean;
  autoRefreshOnCommit: boolean;
  gitnexusVersion: string;
  HintTools: string[];
  allowNpxFallback: boolean;
  indexOnly: boolean;
}

const DEFAULTS: PluginConfig = {
  autoIndex: true,
  autoRefreshStale: true,
  autoRefreshOnCommit: true,
  gitnexusVersion: "1.6.12",
  HintTools: ["grep", "glob", "read", "bash"],
  allowNpxFallback: false,
  indexOnly: true,
};

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function loadConfig(worktree?: string): PluginConfig {
  const globalPath = join(homedir(), ".config", "opencode", "gitnexus-opencode.json");
  const projectPath = worktree ? join(worktree, ".opencode", "gitnexus-opencode.json") : null;

  const globalCfg = readJsonSafe(globalPath) ?? {};
  const projectCfg = projectPath ? (readJsonSafe(projectPath) ?? {}) : {};
  const merged = { ...globalCfg, ...projectCfg };

  return {
    autoIndex: typeof merged.autoIndex === "boolean" ? merged.autoIndex : DEFAULTS.autoIndex,
    autoRefreshStale: typeof merged.autoRefreshStale === "boolean" ? merged.autoRefreshStale : DEFAULTS.autoRefreshStale,
    autoRefreshOnCommit: typeof merged.autoRefreshOnCommit === "boolean" ? merged.autoRefreshOnCommit : DEFAULTS.autoRefreshOnCommit,
    gitnexusVersion: typeof merged.gitnexusVersion === "string" && merged.gitnexusVersion.length > 0
      ? merged.gitnexusVersion
      : DEFAULTS.gitnexusVersion,
    HintTools: Array.isArray(merged.HintTools)
      ? (merged.HintTools as unknown[]).filter((t): t is string => typeof t === "string")
      : DEFAULTS.HintTools,
    allowNpxFallback: typeof merged.allowNpxFallback === "boolean"
      ? merged.allowNpxFallback
      : process.env.GITNEXUS_ALLOW_NPX_FALLBACK === "1",
    indexOnly: typeof merged.indexOnly === "boolean" ? merged.indexOnly : DEFAULTS.indexOnly,
  };
}

export function resolveLocalGitnexusBin(): string | null {
  if (process.env.GITNEXUS_BIN && process.env.GITNEXUS_BIN.trim().length > 0) {
    return process.env.GITNEXUS_BIN.trim();
  }
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["gitnexus"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

export function gitnexusCmd(cfg: PluginConfig): string[] {
  const localBin = resolveLocalGitnexusBin();
  if (localBin) {
    return [localBin];
  }
  if (cfg.allowNpxFallback) {
    return ["npx", "-y", `gitnexus@${cfg.gitnexusVersion}`];
  }
  return ["gitnexus"];
}
