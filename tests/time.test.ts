import assert from "node:assert/strict"
import { test } from "node:test"
import { ageTone } from "../src/lib/time.ts"

const now = Date.UTC(2026, 0, 1, 12, 0, 0)
const minutes = (n: number) => n * 60_000

test("ageTone separa menos de una hora, hasta un dia y mas de un dia", () => {
  assert.equal(ageTone(now - minutes(59), now), "fresh")
  assert.equal(ageTone(now - minutes(60), now), "today")
  assert.equal(ageTone(now - minutes(23 * 60 + 59), now), "today")
  assert.equal(ageTone(now - minutes(24 * 60), now), "old")
  assert.equal(ageTone(0, now), "old")
})
