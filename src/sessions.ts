/**
 * SEC-006: Tri-state session classification registry ("main" | "subagent" | "unknown").
 *
 * Why unknown sessions must FAIL CLOSED (`"unknown"` -> not main):
 *
 *   - `parentID` on `event(session.created)` or `client.session.list()`
 *     distinguishes spawned subagent sessions from main orchestrator sessions.
 *   - Treating `"unknown"` as `"main"` allowed an unclassified subagent (e.g.
 *     when `client.session.list()` failed, while hydration was still in flight,
 *     or after `session.deleted`) to bypass the `OPT_IN_MARKER` check and
 *     automatically receive the repository graph envelope.
 *   - Both main sessions (no `parentID`) and subagents (with `parentID`) are
 *     positively recorded on `session.created` and during `session.list()`
 *     hydration. Any session not yet classified remains `"unknown"` and cannot
 *     receive automatic graph injection.
 *
 * Each call to `createSessionRegistry()` returns its own isolated Map, so two
 * plugin instances in the same node process do not share state.
 */

export type SessionKind = "main" | "subagent" | "unknown"

export interface SessionRegistry {
  trackCreated(info: { id: string; parentID?: string }): void
  trackDeleted(info: { id: string }): void
  getKind(sessionID: string): SessionKind
  isMain(sessionID: string): boolean
  /** Test helper: clear every tracked session. */
  reset(): void
}

export function createSessionRegistry(): SessionRegistry {
  const sessions = new Map<string, "main" | "subagent">()

  return {
    trackCreated(info) {
      if (!info.id) return
      sessions.set(info.id, info.parentID ? "subagent" : "main")
    },
    trackDeleted(info) {
      sessions.delete(info.id)
    },
    getKind(sessionID) {
      return sessions.get(sessionID) ?? "unknown"
    },
    isMain(sessionID) {
      return sessions.get(sessionID) === "main"
    },
    reset() {
      sessions.clear()
    },
  }
}
