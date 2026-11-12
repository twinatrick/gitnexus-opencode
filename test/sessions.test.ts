import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createSessionRegistry, type SessionRegistry } from "../src/sessions.js"

describe("SessionRegistry (SEC-006: tri-state fail-closed classification)", () => {
  let registry: SessionRegistry
  beforeEach(() => {
    registry = createSessionRegistry()
  })

  it("fresh state: unknown sessions are classified as 'unknown' and fail closed (isMain === false)", () => {
    assert.equal(registry.getKind("X"), "unknown")
    assert.equal(registry.isMain("X"), false)
  })

  it("trackCreated with no parentID records the session as 'main'", () => {
    registry.trackCreated({ id: "X" })
    assert.equal(registry.getKind("X"), "main")
    assert.equal(registry.isMain("X"), true)
  })

  it("trackCreated with parentID records the session as 'subagent' (not main)", () => {
    registry.trackCreated({ id: "Y", parentID: "X" })
    assert.equal(registry.getKind("Y"), "subagent")
    assert.equal(registry.isMain("Y"), false)
  })

  it("trackDeleted reverts a session back to 'unknown' (never grants main access)", () => {
    registry.trackCreated({ id: "X" })
    registry.trackCreated({ id: "Y", parentID: "X" })
    assert.equal(registry.getKind("X"), "main")
    assert.equal(registry.getKind("Y"), "subagent")

    registry.trackDeleted({ id: "X" })
    registry.trackDeleted({ id: "Y" })
    assert.equal(registry.getKind("X"), "unknown")
    assert.equal(registry.isMain("X"), false)
    assert.equal(registry.getKind("Y"), "unknown")
    assert.equal(registry.isMain("Y"), false)
  })

  it("multiple main and subagent sessions are tracked independently", () => {
    registry.trackCreated({ id: "M" })
    registry.trackCreated({ id: "A", parentID: "M" })
    registry.trackCreated({ id: "B", parentID: "M" })
    registry.trackCreated({ id: "C", parentID: "M" })
    assert.equal(registry.getKind("M"), "main")
    assert.equal(registry.getKind("A"), "subagent")
    assert.equal(registry.getKind("B"), "subagent")
    assert.equal(registry.getKind("C"), "subagent")

    registry.trackDeleted({ id: "B" })
    assert.equal(registry.getKind("M"), "main")
    assert.equal(registry.getKind("A"), "subagent")
    assert.equal(registry.getKind("B"), "unknown")
    assert.equal(registry.isMain("B"), false)
    assert.equal(registry.getKind("C"), "subagent")
  })

  it("reset clears every tracked session back to 'unknown' (fail-closed)", () => {
    registry.trackCreated({ id: "M" })
    registry.trackCreated({ id: "A", parentID: "M" })
    registry.reset()
    assert.equal(registry.getKind("M"), "unknown")
    assert.equal(registry.isMain("M"), false)
    assert.equal(registry.getKind("A"), "unknown")
    assert.equal(registry.isMain("A"), false)
  })

  it("deleting an unknown session is a no-op and remains 'unknown'", () => {
    assert.doesNotThrow(() => registry.trackDeleted({ id: "never-existed" }))
    assert.equal(registry.getKind("never-existed"), "unknown")
    assert.equal(registry.isMain("never-existed"), false)
  })

  it("two independent registries do not share state", () => {
    const a = createSessionRegistry()
    const b = createSessionRegistry()
    a.trackCreated({ id: "same-id" })
    assert.equal(a.getKind("same-id"), "main")
    assert.equal(a.isMain("same-id"), true)
    assert.equal(b.getKind("same-id"), "unknown")
    assert.equal(b.isMain("same-id"), false)
  })

  it("hydration via repeated trackCreated restores both main and subagent classification while leaving unknown sessions fail-closed", () => {
    const sessionsFromApi = [
      { id: "main-1" },
      { id: "sub-1", parentID: "main-1" },
      { id: "sub-2", parentID: "main-1" },
      { id: "main-2" },
    ]
    for (const s of sessionsFromApi) registry.trackCreated(s)
    assert.equal(registry.getKind("main-1"), "main")
    assert.equal(registry.isMain("main-1"), true)
    assert.equal(registry.getKind("sub-1"), "subagent")
    assert.equal(registry.isMain("sub-1"), false)
    assert.equal(registry.getKind("sub-2"), "subagent")
    assert.equal(registry.isMain("sub-2"), false)
    assert.equal(registry.getKind("main-2"), "main")
    assert.equal(registry.isMain("main-2"), true)
    assert.equal(registry.getKind("never-seen"), "unknown")
    assert.equal(registry.isMain("never-seen"), false)
  })
})
