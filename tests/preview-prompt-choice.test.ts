import { test } from "node:test"
import assert from "node:assert/strict"
import { preparePreviewChoice, previewPreferenceContext } from "../src/preview/prompt-choice.ts"
import type { PreviewIdentity, PreviewState } from "../src/preview/types.ts"

const identity: PreviewIdentity = { project: "D:/flufy", conversationId: "session", taskId: "task" }
function client(initial: PreviewState | null = null) {
  let state = initial
  const choices: { identity: PreviewIdentity; choice: string }[] = []
  return {
    choices,
    load: async () => state,
    choose: async (identity: PreviewIdentity, choice: "create" | "skip") => {
      choices.push({ identity, choice })
      state = { identity, status: choice === "create" ? "draft" : "skipped", revisions: [], currentRevisionId: null, approval: null }
      return state
    },
  }
}

test("unchecked skips once at send time without asking on subsequent messages", async () => {
  const api = client()
  await preparePreviewChoice(api, identity, false)
  await preparePreviewChoice(api, identity, false)
  assert.deepEqual(api.choices, [{ identity, choice: "skip" }])
  assert.match(previewPreferenceContext(false), /sin crear una previa.*No preguntes/)
})

test("checking after a skipped message creates the preview for the same task", async () => {
  const api = client()
  await preparePreviewChoice(api, identity, false)
  await preparePreviewChoice(api, identity, true)
  await preparePreviewChoice(api, identity, true)
  assert.deepEqual(api.choices.map(c => c.choice), ["skip", "create"])
  assert.ok(api.choices.every(c => c.identity === identity))
  assert.match(previewPreferenceContext(true), /prepará la previa.*No preguntes.*aprobación/)
})

test("unchecking before a design exists cancels creation", async () => {
  const api = client()
  await preparePreviewChoice(api, identity, true)
  await preparePreviewChoice(api, identity, false)
  assert.deepEqual(api.choices.map(c => c.choice), ["create", "skip"])
})

test("a saved approved design is never overwritten by the checkbox", async () => {
  const state: PreviewState = { identity, status: "approved", revisions: [], currentRevisionId: "r1", approval: { revisionId: "r1", approvedAt: 1, notes: "" } }
  const api = client(state)
  await preparePreviewChoice(api, identity, false)
  await preparePreviewChoice(api, identity, true)
  assert.deepEqual(api.choices, [])
  assert.equal(await api.load(), state)
})
