# gitnexus-opencode (Hardened OpenCode Security Fork)

This fork of `antomy-gc/gitnexus-opencode` (`v0.5.3`) implements air-gap compatibility and working-tree safety hardening:

1. **Offline Binary Resolution**: `gitnexusCmd()` resolves `GITNEXUS_BIN` or the local `gitnexus` binary on `PATH` before falling back to `npx`, allowing zero-network execution inside rootless air-gapped containers.
2. **Pure Index Mode (`--index-only`)**: Background indexing and the `gitnexus_analyze` tool pass `--index-only` by default so `AGENTS.md`, `CLAUDE.md`, and `.claude/skills/` inside target repositories are never modified without explicit consent.
3. **XML Envelope Sanitization**: `src/hint-envelope.ts` sanitizes repository names, commit messages, and body lines against `</gitnexus_graph>` XML breakout and control-character injection.
