# gitnexus-opencode (Hardened OpenCode Security Fork)

This fork of `antomy-gc/gitnexus-opencode` (`v0.5.3`) implements zero-trust configuration boundaries, supply-chain hardening, CLI capability verification, air-gap compatibility, and XML output sanitization:

1. **Zero-Trust Configuration Boundary (SEC-001 & SEC-002)**:
   - `allowNpxFallback`, `gitnexusVersion`, and `indexOnly` (disabling) are strictly **user-level** security controls loaded only from `~/.config/opencode/gitnexus-opencode.json`.
   - Untrusted repository configs (`<repo>/.opencode/gitnexus-opencode.json`) cannot enable `npx`, override `gitnexusVersion`, or disable `indexOnly`.
2. **Offline Local Binary Default & Strict Package Source Validation (SEC-001)**:
   - Defaults to `allowNpxFallback = false`. `gitnexusCmd()` resolves `GITNEXUS_BIN` or `gitnexus` on `PATH` and fails safely if absent.
   - Automatic CLI checks (`session.created`) never invoke `npx` or trigger network downloads.
   - `isValidGitnexusVersion()` enforces canonical SemVer `>= 1.6.12` and rejects `npm:` aliases, Git URLs, `file:` URLs, tarball URLs, path traversal, and registry flags.
3. **Pure Index Mode (`--index-only`) Enforcement (SEC-002)**:
   - Defaults to `indexOnly = true` across both background indexing (`src/hooks.ts`) and tool execution (`gitnexus_analyze` in `src/index.ts`) via `buildAnalyzeArgs()`, preventing unauthorized modification of `AGENTS.md`, `CLAUDE.md`, and `.claude/skills/`.
4. **End-to-End XML Sanitization & Escaping (SEC-003)**:
   - `buildEnvelope()` in `src/hint-envelope.ts` applies `sanitizeXmlAttr()` / `sanitizeXmlText()` followed by `escapeXml()` to all envelope attributes and text nodes (`Untrusted Input -> Input Validation -> Control Character Sanitization -> XML Escaping -> XML Envelope Generation`).
5. **CLI SemVer & Capability Verification (COMP-001)**:
   - `checkGitNexusCliCompatibility()` enforces `MIN_SUPPORTED_GITNEXUS_VERSION = "1.6.12"` via numeric SemVer comparison and verifies `--index-only` support via `gitnexus analyze --help`.
