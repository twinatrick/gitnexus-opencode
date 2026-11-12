# gitnexus-opencode (Hardened OpenCode Security Fork)

This fork of `antomy-gc/gitnexus-opencode` (`v0.5.3`) implements zero-trust configuration boundaries, supply-chain hardening, CLI capability verification, air-gap compatibility, and XML output sanitization:

1. **Zero-Trust Configuration Boundary (SEC-001 & SEC-002)**:
   - `indexOnly` (disabling) is strictly a **user-level** security control loaded only from `~/.config/opencode/gitnexus-opencode.json`.
   - Untrusted repository configs (`<repo>/.opencode/gitnexus-opencode.json`) cannot disable `indexOnly`.
   - `allowNpxFallback` and `gitnexusVersion` were removed from the schema. If either appears in user or repository config, it is ignored and a deprecation warning is logged.
2. **Local-Binary-Only Execution & Package-Source Isolation (SEC-004)**:
   - The plugin never spawns `npm`, `npx`, `pnpm`, `yarn`, or `bunx`. `gitnexusCmd()` resolves only `GITNEXUS_BIN` or a local `gitnexus` on `PATH`, and throws a clear error if absent.
   - Because no package manager runs, a repository `.npmrc` (for example `registry=https://attacker.example.com/`) and repository `package.json` cannot influence package resolution or download code at runtime.
   - Automatic CLI checks (`session.created`) never trigger network downloads.
   - `test/npmrc-registry.test.ts` pins the invariant: malicious repo `.npmrc`, fake `npm`/`npx` shims that would write a marker, and static source scans for quoted package-manager literals.
3. **Pure Index Mode (`--index-only`) Enforcement (SEC-002)**:
   - Defaults to `indexOnly = true` across both background indexing (`src/hooks.ts`) and tool execution (`gitnexus_analyze` in `src/index.ts`) via `buildAnalyzeArgs()`, preventing unauthorized modification of `AGENTS.md`, `CLAUDE.md`, and `.claude/skills/`.
4. **End-to-End XML Sanitization & Escaping (SEC-003)**:
   - `buildEnvelope()` in `src/hint-envelope.ts` applies `sanitizeXmlAttr()` / `sanitizeXmlText()` followed by `escapeXml()` to all envelope attributes and text nodes (`Untrusted Input -> Input Validation -> Control Character Sanitization -> XML Escaping -> XML Envelope Generation`).
5. **CLI SemVer & Capability Verification (COMP-001)**:
   - `checkGitNexusCliCompatibility()` enforces `MIN_SUPPORTED_GITNEXUS_VERSION = "1.6.12"` via numeric SemVer comparison and verifies `--index-only` support via `gitnexus analyze --help`.
6. **Decoupled Lifecycle (COMP-002)**:
   - A missing or incompatible CLI no longer sets a global `disabled` flag. Session startup still discovers repos and refreshes the hint cache.
   - `system.transform` injects while a CLI is usable **or** an indexed repo exists; `messages.transform` keeps working from the index. Only `gitnexus_analyze`, background re-indexing, and the `init` skill prerequisite are CLI-gated.
   - `session.created` never attempts a download, so startup cannot hang or fail because GitNexus is absent. `test/plugin-lifecycle.test.ts` covers missing CLI with/without an index and a present local binary.
