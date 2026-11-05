# Installing gitnexus-opencode

Add the `gitnexus-opencode` plugin and the `gitnexus` MCP server to the OpenCode configuration. Follow these steps exactly.

## Execution Modes

1. **Local Binary Mode (Default)**: Uses the locally installed `gitnexus` binary (`>= 1.6.12`) on `PATH` or specified via `GITNEXUS_BIN`. Does not make network calls or invoke `npx`.
2. **Air-Gap Mode**: For isolated / offline environments, pre-install `gitnexus` (`>= 1.6.12`) from an offline package cache or bundle and set `GITNEXUS_BIN=/path/to/gitnexus` if not on `PATH`. Keep `allowNpxFallback: false` (default) and `indexOnly: true` (default).
3. **Explicitly Authorized npm Fallback Mode (Opt-In, Requires Network)**: Only if the user explicitly sets `"allowNpxFallback": true` in their user-level `~/.config/opencode/gitnexus-opencode.json` (or `GITNEXUS_ALLOW_NPX_FALLBACK=1`) will the plugin fall back to `npx -y gitnexus@<version>` when no local binary is present. Repository-level `.opencode/gitnexus-opencode.json` files cannot enable `npx` or disable `indexOnly`.

## Step 1: Verify local GitNexus CLI (`>= 1.6.12`)

Ensure `gitnexus` is installed locally and supports `--index-only`:

```bash
gitnexus --version
gitnexus analyze --help
```

If `gitnexus` is not installed yet:
- **Standard local install**: `npm install -g gitnexus@1.6.12`
- **Offline / Air-Gap install**: `npm install -g ./gitnexus-1.6.12.tgz --offline` (or set `GITNEXUS_BIN` to the unpacked CLI path).

## Step 2: Locate the OpenCode config file

Check `~/.config/opencode/opencode.json` (or `.jsonc`). Create it if it doesn't exist.

## Step 3: Edit the config

Read the existing file first. Merge the following into it — do NOT overwrite existing plugins, MCP servers, providers, or other settings:

1. Add `"gitnexus-opencode"` to the `"plugin"` array (create the array if absent).
2. Add the `"gitnexus"` entry under `"mcp"` using the local `gitnexus` binary (create the object if absent):

```json
{
  "plugin": ["gitnexus-opencode"],
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["gitnexus", "mcp"]
    }
  }
}
```

> **Note on `npx` (Opt-In Only):** Do not use `npx -y gitnexus` unless the user has network connectivity and explicitly opts in to `npx` execution.

## Step 4: Index the current repository (Pure Index Mode)

If the current working directory is a git repository and does not have a `.gitnexus/` directory yet, run:

```bash
gitnexus analyze --index-only
```

Using `--index-only` builds the code knowledge graph in `.gitnexus/` without modifying `AGENTS.md`, `CLAUDE.md`, or `.claude/skills/` in the working tree.

## Step 5: Done

Tell the user to restart OpenCode for the plugin and MCP server to activate.
