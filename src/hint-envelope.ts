import { discoverRepos, type RepoInfo } from "./discovery.js"

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

const XML_NONCHAR_RE = /[\uFFFE\uFFFF]/g

const DISALLOWED_TEXT_CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F]/g

const DISALLOWED_ATTR_CTRL_RE = /[\x00-\x1F\x7F-\x84\x86-\x9F]/g

/**
 * SEC-003 & SEC-007: Input validation + XML 1.0 Fifth Edition character
 * sanitization for text nodes.
 * Normalizes CRLF/CR line endings to LF, removes lone UTF-16 surrogates
 * (U+D800-U+DFFF), removes noncharacters (U+FFFE, U+FFFF), and strips
 * disallowed XML 1.0 control characters while preserving valid horizontal
 * tab (\t) and line feed (\n).
 */
export function sanitizeXmlText(val: unknown): string {
  const validated = typeof val === "string" ? val : String(val ?? "")
  return validated
    .replace(/\r\n?/g, "\n")
    .replace(LONE_SURROGATE_RE, "")
    .replace(XML_NONCHAR_RE, "")
    .replace(DISALLOWED_TEXT_CTRL_RE, "")
    .replace(LONE_SURROGATE_RE, "")
}

/**
 * SEC-003 & SEC-007: Input validation + XML 1.0 Fifth Edition character
 * sanitization for XML attributes.
 * Normalizes embedded newlines/tabs to spaces, removes lone UTF-16 surrogates
 * (U+D800-U+DFFF), removes noncharacters (U+FFFE, U+FFFF), and strips all
 * C0/DEL/C1 control characters.
 */
export function sanitizeXmlAttr(val: unknown): string {
  const validated = typeof val === "string" ? val : String(val ?? "")
  return validated
    .replace(/[\r\n\t]+/g, " ")
    .replace(LONE_SURROGATE_RE, "")
    .replace(XML_NONCHAR_RE, "")
    .replace(DISALLOWED_ATTR_CTRL_RE, "")
    .replace(LONE_SURROGATE_RE, "")
}

/**
 * Encodes XML special characters (&, <, >, ", ').
 * Must be applied AFTER control character sanitization.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/**
 * State of the cached graph hint envelope.
 *
 * - `up_to_date`   — at least one repo is indexed and not stale, no refresh in flight
 * - `refreshing`   — at least one repo is currently being analyzed in background
 * - `may_be_stale` — at least one indexed repo is stale (HEAD drifted) and no refresh active
 * - `missing`      — no repo is indexed at all (envelope is empty, hook should skip injection)
 */
export type GraphFreshness = "up_to_date" | "refreshing" | "may_be_stale" | "missing"

export interface HintCacheState {
  envelope: string
  freshness: GraphFreshness
  updatedAt: number
}

/**
 * Stable opt-in marker the orchestrator writes into a subagent prompt to grant
 * graph access to that subagent. The plugin's messages.transform hook detects
 * this marker, prepends the envelope, and strips the marker from the prompt.
 */
export const OPT_IN_MARKER = "[[gitnexus:graph]]"

/**
 * A per-plugin-instance hint-envelope state container. Each call to
 * createHintEnvelopeState() returns its own isolated cache and refreshing set,
 * so two plugin instances sharing the same node process (e.g. two workspaces
 * loaded simultaneously) cannot overwrite each other's envelopes.
 */
export interface HintEnvelopeState {
  /** Mark a repo as being refreshed in the background. */
  markRefreshing(repoPath: string): void
  /** Clear the refreshing flag for a repo. */
  markRefreshDone(repoPath: string): void
  /** Read the current cached envelope. */
  getHintCache(): HintCacheState
  /** Rebuild the cache from an explicit repo list (pure). */
  rebuildHintCache(repos: RepoInfo[]): void
  /** Discover repos under `scanRoot` and rebuild the cache from the result. */
  refreshHintCache(scanRoot: string): void
  /** Test helper: reset to initial empty state. */
  reset(): void
}

export function createHintEnvelopeState(): HintEnvelopeState {
  const refreshing = new Set<string>()
  let cache: HintCacheState = {
    envelope: "",
    freshness: "missing",
    updatedAt: 0,
  }

  function rebuildHintCache(repos: RepoInfo[]): void {
    const indexed = repos.filter((r) => r.hasIndex)

    if (indexed.length === 0) {
      cache = { envelope: "", freshness: "missing", updatedAt: Date.now() }
      return
    }

    const anyRefreshing = indexed.some((r) => refreshing.has(r.path))
    const anyStale = indexed.some((r) => r.isStale)

    let freshness: GraphFreshness
    if (anyRefreshing) freshness = "refreshing"
    else if (anyStale) freshness = "may_be_stale"
    else freshness = "up_to_date"

    cache = {
      envelope: buildEnvelope(indexed, freshness),
      freshness,
      updatedAt: Date.now(),
    }
  }

  return {
    markRefreshing(repoPath) {
      refreshing.add(repoPath)
    },
    markRefreshDone(repoPath) {
      refreshing.delete(repoPath)
    },
    getHintCache() {
      return cache
    },
    rebuildHintCache,
    refreshHintCache(scanRoot) {
      const repos = discoverRepos(scanRoot)
      rebuildHintCache(repos)
    },
    reset() {
      refreshing.clear()
      cache = { envelope: "", freshness: "missing", updatedAt: 0 }
    },
  }
}

const LEADING_ENVELOPE_RE =
  /^<gitnexus_graph\b[^>]*>[\s\S]*?<\/gitnexus_graph>(?:\r?\n){0,2}/

/**
 * Idempotency scrubber: remove any leading `<gitnexus_graph>...</gitnexus_graph>`
 * blocks (with their trailing newlines) so a stale envelope from a previous
 * turn or compaction doesn't accumulate when we prepend the fresh one.
 *
 * Only matches at start-of-text — envelopes embedded inside user content (e.g.
 * pasted code) are left alone, since they were not put there by us.
 */
export function scrubPromptGitnexusBlocks(text: string): string {
  let scrubbed = text
  while (LEADING_ENVELOPE_RE.test(scrubbed)) {
    scrubbed = scrubbed.replace(LEADING_ENVELOPE_RE, "")
  }
  return scrubbed
}

/**
 * Remove every occurrence of OPT_IN_MARKER from a prompt without touching
 * any other whitespace. Multi-line structure, indentation, markdown, and
 * code fences are preserved verbatim.
 *
 * If the marker sat alone on its own line, the now-empty line is removed
 * so the orchestrator can write:
 *
 *     [[gitnexus:graph]]
 *     real instructions here
 *
 * and the subagent sees just `real instructions here` without a leading
 * blank line. Any other blank lines the user wrote are left intact.
 */
export function stripOptInMarker(text: string): string {
  if (!text.includes(OPT_IN_MARKER)) return text

  // Step 1: if a marker sits alone on its own line (optionally surrounded by
  // horizontal whitespace), remove the entire line including its newline.
  const SOLO_LINE = new RegExp(
    `(^|\r?\n)[ \t]*${escapeRegex(OPT_IN_MARKER)}[ \t]*(?=\r?\n|$)\r?\n?`,
    "g",
  )
  let out = text.replace(SOLO_LINE, (_m, lead) => lead)

  // Step 2: strip any remaining inline occurrences verbatim. The surrounding
  // whitespace is left alone so interior code / markdown / structure survives.
  out = out.split(OPT_IN_MARKER).join("")

  // Step 3: trim only leading/trailing horizontal whitespace. Interior and
  // vertical whitespace are preserved byte-for-byte.
  return out.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function freshnessSummary(freshness: GraphFreshness): string {
  switch (freshness) {
    case "up_to_date":
      return "Code knowledge graph is available. Graph is current."
    case "refreshing":
      return "Code knowledge graph is available. A background refresh is in progress; some symbols may be from the previous HEAD until it completes."
    case "may_be_stale":
      return "Code knowledge graph is available but may be stale (HEAD has moved since last analyze). Results are still useful for structure; re-run gitnexus_analyze if precision matters."
    case "missing":
      return ""
  }
}

/**
 * Follows the SEC-003 processing order:
 * Untrusted Input -> Input Validation -> Control Character Sanitization -> XML Escaping -> XML Envelope Generation
 */
function buildEnvelope(indexed: RepoInfo[], freshness: GraphFreshness): string {
  const safeFreshness = escapeXml(sanitizeXmlAttr(freshness))
  const safeSummary = escapeXml(sanitizeXmlText(freshnessSummary(freshness)))
  const safeRules = escapeXml(
    sanitizeXmlText(
      `See the GitNexus section of the system prompt for tool preference and subagent propagation rules (marker ${OPT_IN_MARKER}).`,
    ),
  )
  const repoLines = indexed
    .map((r) => {
      const safeName = escapeXml(sanitizeXmlAttr(r.name))
      const safePath = escapeXml(sanitizeXmlAttr(r.path))
      return `<repo name="${safeName}" path="${safePath}"/>`
    })
    .join("\n")

  return `<gitnexus_graph source="gitnexus" version="2" freshness="${safeFreshness}">
<summary>${safeSummary}</summary>
<indexed_repos scope="cwd-tree" note="repos under the current directory tree only; more may be indexed machine-wide (gitnexus_list_repos)">
${repoLines}
</indexed_repos>
<rules>${safeRules}</rules>
</gitnexus_graph>`
}
