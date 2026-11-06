import { mkdir, mkdtemp } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// All disposable data stays in the QA-owned tree, never in user profiles or
// the source skill catalog. Individual callers remove only their own directory.
export async function fixtureDirectory(prefix) {
  const root = new URL("../test-results/improvements-qa/fixtures/", import.meta.url)
  await mkdir(root, { recursive: true })
  return mkdtemp(fileURLToPath(new URL(prefix, root)))
}
