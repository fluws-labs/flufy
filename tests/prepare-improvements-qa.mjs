// Prepare reusable synthetic native-store data. Does not launch or install the
// app and never reads its real database. Import only into a separately bound QA
// profile; active run/session state must come from actual execution, not seeds.
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve, join } from 'node:path'

const root = resolve('test-results/improvements-qa')
const project = join(root, 'project')
const seed = join(root, 'seed')
for (const directory of [project, seed, join(root, 'profile')]) await mkdir(directory, { recursive: true })
const skill = { id: 'qa', name: 'QA histórica sintética', version: 1, description: 'Fixture, sin datos reales', instructions: 'Conservar esta versión histórica QA.', verificationGuidelines: ['Comparar después del guardado nativo'] }
const team = {
  id: 'qa-improvements-explicit', name: 'QA sintético · límite explícito 3', projectRoot: project,
  allowedRepositories: [project], leadAgentId: 'qa-lead',
  members: [{ id: 'qa-lead', name: 'Lead sintético', role: 'Lead', model: { providerID: 'qa-unconfigured', modelID: 'no-network' }, variant: null, skillRefs: [{ id: 'qa', version: 1 }], instructions: 'No ejecutar modelos con este seed.', tools: ['read'], maxConcurrentTasks: 1 }],
  maxParallelTasks: 3, maxRetriesPerTask: 1, updatedAt: 1,
  planV2: { enabled: false, reviewBeforeStart: true, routing: { enabled: false, routes: [], pinnedAgents: ['qa-lead'], maxWorkersPerProvider: 2 } },
}
const store = { schemaVersion: 1, teams: [team], skills: [skill], chats: [{ id: 'qa-improvements-history', title: 'QA sintético · snapshot histórico', archived: false, createdAt: 1, team: structuredClone(team), skills: [structuredClone(skill)], runs: [], messages: [] }] }
const database = join(seed, 'teams.sqlite')
const existing = existsSync(database)
const db = new DatabaseSync(database)
try {
  if (!existing) {
    db.exec('CREATE TABLE team_store (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)')
    db.prepare('INSERT INTO team_store(id,document) VALUES(1,?)').run(JSON.stringify(store))
  }
  assert.deepEqual(JSON.parse(db.prepare('SELECT document FROM team_store WHERE id=1').get().document), store, 'never overwrite a modified fixture')
} finally { db.close() }
const json = join(seed, 'store-before.json')
if (!existsSync(json)) await writeFile(json, JSON.stringify(store, null, 2) + '\n', { flag: 'wx' })
assert.deepEqual(JSON.parse(await readFile(json, 'utf8')), store)
console.log('Synthetic QA seed prepared and SQLite readback verified: schema 1, explicit limits 3/2, historical QA v1, no active sessions, no model calls. Not imported into an application profile.')
