import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile, mkdir, writeFile, rm, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fixtureDirectory } from "./fixture-directory.mjs"
import { available, installSkills, revision } from "../scripts/install-superpowers-skills.mjs"

const text = async (path: string) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n")

// Temporary projects stay inside the QA-owned tree, not user projects.
async function project(run: (root: string) => Promise<void>) {
  const root = await fixtureDirectory("superpowers-")
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("selectively installs a discoverable project skill and MIT license, without bootstrap", async () => {
  await project(async root => {
    const result = await installSkills(root, ["systematic-debugging"])
    assert.deepEqual(result.map(s => s.status), ["installed"])
    const directory = join(root, ".opencode/skills")
    assert.deepEqual(await readdir(directory), ["superpowers-systematic-debugging"])
    const document = await text(join(directory, "superpowers-systematic-debugging/SKILL.md"))
    assert.match(document, /^---\nname: superpowers-systematic-debugging\n/)
    assert.ok(document.includes(revision))
    assert.match(document, /Contrato de Flufy/)
    assert.match(await readFile(join(directory, "superpowers-systematic-debugging/LICENSE"), "utf8"), /MIT License/)
    assert.deepEqual((await installSkills(root, ["systematic-debugging"])).map(s => s.status), ["unchanged"])
  })
})

test("custom content is preserved and all conflicts are checked before installation", async () => {
  await project(async root => {
    const directory = join(root, ".opencode/skills/superpowers-verification-before-completion")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "SKILL.md"), "My personalized skill")
    await assert.rejects(installSkills(root, ["systematic-debugging", "verification-before-completion"]), /contenido personalizado/)
    assert.equal(await readFile(join(directory, "SKILL.md"), "utf8"), "My personalized skill")
    assert.deepEqual(await readdir(join(root, ".opencode/skills")), ["superpowers-verification-before-completion"])
  })
})

test("unknown, empty and traversal selections fail without installing anything", async () => {
  await project(async root => {
    for (const ids of [[], ["using-superpowers"], ["../backend"], ["ui-ux-designer"]]) {
      await assert.rejects(installSkills(root, ids))
    }
    assert.deepEqual(await readdir(root), [])
  })
})

test("optional installation preserves historical snapshots, explicit limits and existing project settings byte-for-byte", async () => {
  await project(async root => {
    const snapshot = {
      schemaVersion: 1,
      teams: [{ id: "qa-synthetic", maxParallelTasks: 3, planV2: { routing: { maxWorkersPerProvider: 2 } }, members: [{ skillRefs: [{ id: "qa", version: 1 }] }] }],
      chats: [{ id: "qa-history", skills: [{ id: "qa", version: 1, instructions: "Instrucciones históricas sintéticas" }], runs: [{ id: "qa-completed", status: "completed" }] }],
    }
    const files = {
      "teams.json": JSON.stringify(snapshot, null, 2) + "\n",
      "opencode.json": '{"agent":{"qa":{"skills":["qa"]}}}\n',
    }
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
    assert.deepEqual((await installSkills(root, ["systematic-debugging", "verification-before-completion"])).map(skill => skill.status), ["installed", "installed"])
    for (const [name, content] of Object.entries(files)) assert.equal(await readFile(join(root, name), "utf8"), content, name)
    assert.equal(JSON.stringify(snapshot).includes("superpowers-"), false, "installation does not opt historical teams into skills")
  })
})

test("the nine reviewed adaptations are available to engine discovery and embedded team catalog", async () => {
  assert.equal(available.length, 9)
  assert.deepEqual(
    available.map(skill => skill.slug).sort(),
    [
      "superpowers-brainstorming",
      "superpowers-executing-plans",
      "superpowers-receiving-code-review",
      "superpowers-requesting-code-review",
      "superpowers-systematic-debugging",
      "superpowers-test-driven-development",
      "superpowers-verification-before-completion",
      "superpowers-writing-plans",
      "superpowers-writing-skills",
    ],
  )
  for (const excluded of ["using-superpowers", "using-git-worktrees", "subagent-driven-development", "dispatching-parallel-agents", "finishing-a-development-branch", "diagnosing-superpowers"]) {
    assert.equal(available.some(skill => skill.id.includes(excluded)), false, excluded)
  }
  const rust = await readFile("src-tauri/src/teams/skills.rs", "utf8")
  assert.match(rust, /superpowers-catalog\.json/)
  for (const skill of available) {
    const document = await text(`.opencode/skills/${skill.slug}/SKILL.md`)
    assert.match(document, new RegExp(`^---\\nname: ${skill.slug}\\n`))
    assert.match(document, /compatibility: opencode/)
    assert.match(document, /Contrato de Flufy/)
    assert.ok(rust.includes(`.opencode/skills/${skill.slug}/SKILL.md`))
    assert.ok(document.includes(revision))
    assert.ok(skill.verificationGuidelines.length >= 2)
  }
})
