// Real stdio launcher + pinned SDK, without connecting Chrome or using a user
// profile. This verifies startup/catalog registration, not WebView2 navigation.
import assert from 'node:assert/strict'
import { copyFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { fixtureDirectory } from './fixture-directory.mjs'

const sdk = resolve('test-results/browser-sdk')
const launcher = join(sdk, 'browser_launcher.mjs')
const workspace = join(sdk, 'browser_workspace.mjs')
const dir = await fixtureDirectory('launcher-catalog-')
await copyFile('src-tauri/src/desktop/browser_launcher.mjs', launcher)
await copyFile('src-tauri/src/desktop/browser_workspace.mjs', workspace)
const env = { ...process.env, GUILLECODE_WORKSPACES_FILE: join(dir, 'workspaces.json') }
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|TAURI_SIGNING/.test(key)) delete env[key]
const child = spawn(process.execPath, [launcher, '--no-usage-statistics', '--no-performance-crux', '--category-memory=false', '--category-performance=false'], { cwd: sdk, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const lines = createInterface({ input: child.stdout })
const pending = new Map()
let id = 0
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})
child.stderr.resume()
child.on('error', error => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error) }
  pending.clear()
})
function request(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out: ${method}`)) }, 20000)
    pending.set(requestId, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
  })
}
try {
  const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'flufy-qa-isolated', version: '1' } })
  assert.ok(initialized.capabilities.tools)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const { tools } = await request('tools/list', {})
  for (const name of ['list_pages', 'navigate_page', 'take_snapshot', 'take_screenshot', 'click', 'fill_form', 'evaluate_script']) {
    assert.ok(tools.some(tool => tool.name === name), `Missing ${name} from real launcher catalog`)
  }
  assert.ok(tools.find(tool => tool.name === 'navigate_page').inputSchema.properties.pageId)
  console.log(`Real launcher initialize + tools/list: PASS (${tools.length} tools, required browser actions and pageId schema present; no browser connected)`)
} finally {
  lines.close()
  child.stdin.end()
  child.kill()
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  await rm(dir, { recursive: true, force: true })
  await rm(launcher, { force: true })
  await rm(workspace, { force: true })
}
