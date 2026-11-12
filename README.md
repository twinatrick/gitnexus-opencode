# gitnexus-opencode

OpenCode plugin for [GitNexus](https://github.com/nicepkg/gitnexus) — automatic code graph indexing, staleness detection, and AI agent hints.

## What it does

**On session start:**
- Verifies whether a trusted local GitNexus CLI is reachable (gates `gitnexus_analyze` and background refresh, while keeping existing graph context active)
- Discovers git repos (current dir + subdirectories)
- Classifies the session into `"main"` (no `parentID`) or `"subagent"` (has `parentID`); unclassified sessions remain `"unknown"` and fail closed until classified
- Hydrates the session registry (both `"main"` and `"subagent"`) from `client.session.list()` so existing sessions survive plugin reloads without failing open
- Shows toast with graph status (delayed 6s to avoid oh-my-openagent spinner overlap)
- Background-refreshes stale indexes

**Every chat turn:**
- Pushes a static GitNexus rule block onto the system prompt (cache-friendly, byte-identical between turns)
- Prepends the dynamic indexed-repo envelope to the last user message of eligible sessions
- Deduplicates the envelope per session: if the next-turn envelope is byte-identical to what was last injected into this session, injection is skipped — the agent already carries it in conversation history

**Tools:**

- `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, and other `gitnexus_*` tools — from the GitNexus MCP server. Available to all agents including subagents (requires [permission setup](#allow-gitnexus-tools-for-subagents)).
- `gitnexus_analyze` — plugin tool for building/refreshing the graph. Intended for the main agent. By default it is NOT delegated to subagents unless explicitly permitted in opencode.json.

**Hooks:**

| Hook | Trigger | Action |
|------|---------|--------|
| `tool.execute.after` on `skill` | Skill loaded | Inject graph prerequisite for `init-deep`/`init`, availability hint for others |
| `tool.execute.after` on `bash` | Git mutation detected | Background re-index (cache flips to `freshness=refreshing`, then back to `up_to_date`) |
| `experimental.chat.system.transform` | Every LLM call | Push the static GitNexus rule block onto `output.system` (idempotent; skipped only when no CLI is available **and** no repo is indexed) |
| `experimental.chat.messages.transform` | Every LLM call | Prepend the dynamic graph envelope to the last user message of eligible sessions (main sessions automatically; subagents only if the orchestrator added the `[[gitnexus:graph]]` marker). Skips injection when the envelope is byte-identical to the last one injected into this session (per-session dedup). |

## Two-layer hint architecture

The plugin contributes two distinct pieces of context per chat turn:

**Layer 1 — static system addendum (in system prompt).**
Rules that don't change between sessions: envelope contract, subagent propagation rules, tool preference, a delegate-to-subagent nudge for open-ended graph work, and (for main sessions) the "build a graph yourself" cost/benefit rule. Module-level constant strings, byte-identical across every turn — provider prefix caches keep matching, so the static block is amortized to roughly cached-input cost (≈5× cheaper than uncached on Anthropic).

There are two variants:
- **Full** addendum (~510 tokens) — pushed onto **main** sessions. Covers everything: envelope contract, subagent propagation rules, delegate-to-subagent nudge, and the build-graph rule.
- **Lite** addendum (~160 tokens) — pushed onto **subagent** sessions. Covers only the envelope contract and tool preference. Omits subagent propagation (subagents rarely spawn further subagents) and the build-graph rule (`gitnexus_analyze` is intended for the main agent).

The variant is chosen per chat call from the `sessionID` and the `SessionRegistry`. The registry classifies sessions as `"main"`, `"subagent"`, or `"unknown"` (fail-closed): only positively identified `"main"` sessions receive the Full addendum and automatic user-message envelopes, while `"subagent"` sessions require the explicit `[[gitnexus:graph]]` marker and `"unknown"` sessions fail closed until classified.

**Layer 2 — dynamic envelope (in user message).**
Per-instance data that does change: which repos are indexed in this workspace right now, their paths, and freshness state. Read fresh on every turn. The envelope cross-references the system prompt for the rules instead of duplicating them.

The envelope is **deduplicated per session**: a `LastInjectedRegistry` memoizes the last envelope injected into each session. If the next-turn envelope is byte-identical (no freshness flips, no repos added/removed), the hook skips injection — the agent already has it in conversation history, and re-injecting would only burn uncached input tokens. The memo clears on session deletion or when `<gitnexus_graph>` no longer appears in visible history (compaction guard), so the next turn force-re-injects.

Splitting puts the **rules** in the highest-salience location for instruction-following (system prompt) and keeps **data** in the natural per-turn refresh location (user message). On warm-cache turns the per-turn cost is significantly lower than the previous monolithic envelope; subagents specifically pay roughly a third of what main sessions pay for the static block. On a stable repo state, a long session pays the envelope cost exactly once instead of N times.

## Install

### Execution Modes

| Mode | Network Required | Description |
| --- | --- | --- |
| **1. Local Binary Mode (Default)** | No | Resolves `GITNEXUS_BIN` or the local `gitnexus` binary on `PATH` (minimum supported version: `>= 1.6.12` with `--index-only` support). Fails safely if missing. |
| **2. Air-Gap Mode** | No | Pre-install `gitnexus` (`>= 1.6.12`) from an offline tarball/image or set `GITNEXUS_BIN` to the offline executable. Session checks (`--version` / `analyze --help`) and indexing never trigger network downloads. |

> **Invariant (SEC-004 & SEC-005):** This plugin never invokes `npm`, `npx`, `pnpm`, `yarn`, `bunx`, `which`, or `where`, and it never downloads package code at runtime. It resolves only a trusted local executable from `GITNEXUS_BIN` or `PATH` using Node.js `fs`/`path` APIs, rejecting relative `PATH` entries (`.`), `node_modules/.bin`, and any binary or symlink resolving inside the repository. A repository-level `.npmrc`, `package.json`, or legacy `allowNpxFallback` / `gitnexusVersion` key cannot change the package source or execute repository binaries.

### Prerequisite: Install Local GitNexus CLI (`>= 1.6.12`)

```bash
# Standard local installation
npm install -g gitnexus@1.6.12

# Or in an offline / air-gapped environment
npm install -g ./gitnexus-1.6.12.tgz --offline

gitnexus --version
```

Build and deploy the plugin:
```bash
npm install && npm run build
cp dist/gitnexus-opencode.js ~/.config/opencode/plugins/
```

Configure GitNexus MCP in `~/.config/opencode/opencode.json` using the local binary:
```json
{
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["gitnexus", "mcp"]
    }
  }
}
```

### Allow GitNexus tools for subagents

OpenCode's explore/librarian agents block non-built-in tools by default. Add permissions to `~/.config/opencode/opencode.json` so subagents can use GitNexus MCP tools directly:

```json
{
  "permission": {
    "gitnexus_query": "allow",
    "gitnexus_context": "allow",
    "gitnexus_impact": "allow"
  }
}
```

Without this, the plugin still works — subagents fall back to GitNexus CLI via bash (slower, ~3-5s overhead per call).

Restart OpenCode.

For full step-by-step installation guide (intended for AI agents), see [INSTALL.md](./INSTALL.md).

## Configuration

The plugin enforces a strict **zero-trust boundary** between user-level config (`~/.config/opencode/gitnexus-opencode.json`) and repository-level config (`<repo>/.opencode/gitnexus-opencode.json`):

```json
{
  "autoRefreshStale": true,
  "autoRefreshOnCommit": true,
  "indexOnly": true
}
```

| Key | Default | Scope | Description |
|-----|---------|-------|-------------|
| `autoRefreshStale` | `true` | User or Repo | Refresh stale indexes on session start |
| `autoRefreshOnCommit` | `true` | User or Repo | Refresh after git commit/merge/rebase |
| `indexOnly` | `true` | **User-level only** (Repo cannot set `false`) | Pass `--index-only` to `gitnexus analyze` so repository files (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/`) are never modified unless explicitly authorized by user config |

Legacy keys `allowNpxFallback` and `gitnexusVersion` are ignored in both user and repository config. When present, the plugin logs one warning and continues with local-binary-only execution.

## Build

```bash
npm run build    # tsc + esbuild bundle
```

Produces `dist/gitnexus-opencode.js` — single file, all internal modules bundled, `@opencode-ai/plugin` as external (resolved from OpenCode runtime).

## Architecture

### System addendum delivery (Layer 1)

The static rule block is delivered through `experimental.chat.system.transform`. On every LLM call the plugin appends one of the two addendum variants to `output.system`:

- **Full** for sessions positively identified as `"main"` via the `SessionRegistry`
- **Lite** for `"subagent"` and unclassified (`"unknown"`) sessions

Skipped if:
- no GitNexus CLI is available **and** the workspace has no indexed repo (nothing the addendum could act on; COMP-002), or
- any gitnexus addendum is already present in the array (idempotency, detected via the start sentinel — works across both variants).

A missing CLI never disables the plugin. Existing graph envelopes and `gitnexus_*` MCP tools keep working; only `gitnexus_analyze` and background re-indexing report the missing local binary.

Both variants are wrapped between the same sentinels `<!-- gitnexus:system:start -->` and `<!-- gitnexus:system:end -->`. Neither variant contains per-instance interpolations, so each is byte-identical between turns and across sessions — provider prefix caches match and the cached-input price applies after the first turn.

The full addendum also nudges the main agent to **delegate open-ended exploration or multi-flow tracing to a subagent** with the `[[gitnexus:graph]]` marker, instead of stacking inline `gitnexus_*` calls. This keeps the main agent's context clean on multi-step graph workflows where each tool response (~2-10KB) would otherwise accumulate in history.

The addendum is pushed for every session where the plugin is active, including ones launched from a directory with no locally indexed repos. In that case the addendum tells the agent to call `gitnexus_list_repos` once to discover repos indexed elsewhere on the machine.

#### Session classification (`main` vs. `subagent` vs. `unknown`)

The `SessionRegistry` maintains a tri-state classification (`"main" | "subagent" | "unknown"`). On `session.created`, sessions without `parentID` are recorded as `"main"` and sessions with `parentID` are recorded as `"subagent"`. On `session.deleted`, the session is removed and reverts to `"unknown"`. Any session in the `"unknown"` state fails closed (SEC-006): it never receives automatic `<gitnexus_graph>` injection.

On plugin init the registry is **hydrated** from `client.session.list()`: every existing session is registered as either `"main"` (no `parentID`) or `"subagent"` (has `parentID`). If `client.session.list()` fails or while hydration is still in flight, unclassified sessions remain `"unknown"` (fail-closed) until classified.

### Envelope delivery (Layer 2)

The dynamic envelope is delivered through OpenCode's `experimental.chat.messages.transform` hook. On every LLM call the plugin:

1. Finds the last user message in the transient message array OpenCode is about to send to the model
2. Decides eligibility (fail-closed):
   - **Main session** (`kind === "main"`, top-level, no `parentID`) — eligible automatically
   - **Subagent session** (`kind === "subagent"`) — eligible only if the orchestrator wrote the explicit opt-in marker `[[gitnexus:graph]]` into the subagent's prompt
   - **Unknown session** (`kind === "unknown"`) — never eligible until classified
3. **Per-session dedup check**: if the next-turn envelope is byte-identical to the one last injected into this session, skip injection. Strip the opt-in marker if present (otherwise it would leak into subagent prompts as literal text) and exit. The agent already has the envelope in conversation history.
4. If the envelope is new (or the registry was cleared by compaction), scrubs any leading `<gitnexus_graph>...</gitnexus_graph>` block left over from a previous turn (idempotency), strips the opt-in marker, and prepends the fresh envelope to the user message text. Records the injection in the `LastInjectedRegistry`.
5. Logs an `info`-level summary line so the behavior is observable from the plugin log file

The envelope itself is small (`<summary>`, `<indexed_repos>`, and a `<rules>` cross-reference back to the system prompt). It is read fresh on every LLM turn, so agents always see the current freshness state (`up_to_date` / `refreshing` / `may_be_stale` / `missing`).

**Compaction guard.** The handler clears the per-session memo when no `<gitnexus_graph>` block survives in the visible message history. After OpenCode compacts a session, the next turn force-re-injects so the agent never operates without the envelope when it expects one.

### Auto-refresh on git mutations

The `tool.execute.after` hook watches for git mutation commands (`commit`, `merge`, `rebase`, `pull`, `cherry-pick`, `switch`, `reset`). When one is detected in a `bash` call, the plugin:

1. Marks the affected repo as refreshing in the hint cache and rebuilds the cache immediately, so the very next user turn sees `freshness="refreshing"`
2. Spawns `gitnexus analyze` in the background (detached, output piped to /dev/null)
3. On process close, marks the repo as no longer refreshing and rebuilds the cache again, so the next turn sees `freshness="up_to_date"` (or `may_be_stale` if HEAD drifted again during analyze)

### For orchestrators

The static rule block in the system prompt teaches every main agent how the propagation marker works and when to use it — including which `subagent_type` values qualify, the path-based override rule, and when to build a graph yourself for deep investigation of an unindexed repo. You don't need to teach this from scratch in your orchestrator system prompt; it's already there.

The orchestrator (Sisyphus, Prometheus, OMO, your custom main agent, etc.) decides per spawn whether the subagent should see the dynamic envelope by including the marker `[[gitnexus:graph]]` anywhere in the subagent's prompt text. The plugin detects the marker, prepends the envelope, and strips the marker so the subagent never sees it as literal text.

**Recommended grant** (parent should add the marker):
- `explore`, `deep`, `build`, `quick`, `refactor`, `sisyphus-junior`, `general` — code-investigation agents
- Any subagent whose prompt mentions an absolute path inside an indexed repo, regardless of `subagent_type`

**Recommended skip** (parent omits the marker):
- `librarian`, doc/knowledge lookup agents
- `oracle` and other reasoning-only agents
- Plan critics (`Momus`, `Metis`), plan builders (`Prometheus`)
- Writing / multimodal / non-code agents

A lite variant of the rule block is pushed onto every subagent's system prompt by the same `system.transform` hook, so even a subagent spawned without the marker still knows the envelope contract (`gitnexus_list_repos` for self-discovery if the orchestrator forgot the marker) and the tool preference list. The marker controls only whether the **per-instance repo data** is delivered as a user-message envelope.

**Example spawn (from a main agent):**

```
task(
  subagent_type="explore",
  prompt="[[gitnexus:graph]] List every caller of buildEnvelope in the repo"
)
```

Inside the spawned subagent the prompt becomes:

```xml
<gitnexus_graph source="gitnexus" version="2" freshness="up_to_date">
<summary>Code knowledge graph is available. Graph is current.</summary>
<indexed_repos>
<repo name="myproj" path="/Users/me/code/myproj"/>
</indexed_repos>
<rules>See the GitNexus section of the system prompt for tool preference and subagent propagation rules (marker [[gitnexus:graph]]).</rules>
</gitnexus_graph>

List every caller of buildEnvelope in the repo
```

The marker itself is gone — the subagent only sees the envelope and the cleaned prompt.

## Uninstall

Remove `~/.config/opencode/plugins/gitnexus-opencode.js` and restart OpenCode.

If you added GitNexus permissions to `opencode.json`, remove the `gitnexus_query`, `gitnexus_context`, `gitnexus_impact` entries from the `permission` object.

If your orchestrator prompts contain literal `[[gitnexus:graph]]` markers, those become harmless inert text once the plugin is removed. You can leave them or strip them at your convenience.

For full cleanup see [UNINSTALL.md](./UNINSTALL.md).

## License

MIT
