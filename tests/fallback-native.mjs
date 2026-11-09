import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdir, readFile, writeFile, realpath, access, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// Real bundled engine, Tauri scheduler and SQLite, deterministic inference only.
// Each invocation retains its own reports; never clears another test's evidence.
const identifier = `com.guillecode.fallback-test-${randomUUID()}`
const root = resolve('test-results', identifier)
await mkdir(join(root, 'repo'), { recursive: true })
const repo = await realpath(join(root, 'repo'))
const report = join(root, 'report.json')
const appData = process.env.APPDATA && join(process.env.APPDATA, identifier)
const preflightOnly = process.argv.includes('--preflight-only')
await writeFile(join(repo, 'user.txt'), 'QA-FALLBACK preserved user work\n')
const delay = ms => new Promise(done => setTimeout(done, ms))
const exists = async path => { try { await access(path); return true } catch { return false } }
const node = `& '${process.execPath.replaceAll("'", "''")}'`
const commands = Object.fromEntries(['fallback-done', 'fallback-pending'].map(id => [id,
  `${node} -e "require('fs').appendFileSync('${id}.effect','once\\n')"`]))
let released = false
let workerCalls = 0
let fixtureError
const requests = []
const mock = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    if (!request.url.endsWith('/responses')) return response.end('{}')
    const body = JSON.parse(raw)
    const latest = [...body.input].reverse().find(item => item.role === 'user')
    const prompt = typeof latest?.content === 'string' ? latest.content : (latest?.content ?? []).map(part => part.text ?? '').join('\n')
    const outputs = body.input.filter(item => item.type === 'function_call_output')
    const phase = [
      ['plan-review', 'Sos el Supervisor de planificación.'], ['plan', 'Actuás como Team Lead.'],
      ['review', 'Sos el Lead revisor'], ['review', 'Sos el Supervisor revisor'],
      ['assessment', 'Sos el Supervisor de cumplimiento'], ['closeout', 'Sos el Lead de cierre'],
    ].map(([name, marker]) => [name, prompt.indexOf(marker)]).filter(([, index]) => index >= 0).sort((a, b) => a[1] - b[1])[0]?.[0]
    requests.push({ model: body.model, phase: phase ?? 'conversation-or-worker', outputs: outputs.length })
    if (body.model === 'primary' || body.model === 'secondary' && phase === 'plan') {
      if (body.model === 'primary') {
        const deadline = Date.now() + 60000
        while (!await exists(`${report}.initial.json`)) {
          assert.ok(Date.now() < deadline, 'Initial durable snapshot gate timed out')
          await delay(50)
        }
      }
      response.writeHead(429, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'The usage limit has been reached' } }))
    }
    const message = value => ({ type: 'message', id: `msg-${randomUUID()}`, role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }], status: 'completed' })
    let item
    if (phase === 'plan') item = message({ uiReviewRequired: false, uiReviewReason: 'Fixture de persistencia sin cambios UI', projectConstraints: [], tasks: ['fallback-done', 'fallback-pending'].map((id, index) => ({
      id, title: id, objective: `Ejecutar exactamente una vez ${commands[id]} y comprobar el resultado observado`, assignedAgentId: 'worker', repository: repo,
      dependencies: index ? ['fallback-done'] : [], expectedFiles: [`${id}.effect`], writePaths: [`${id}.effect`], acceptanceCriteria: ['Efecto aplicado una sola vez'],
    })) })
    else if (phase === 'plan-review') item = message({ covered: true, summary: 'Ambos efectos están cubiertos', missingRequirements: [] })
    else if (phase === 'assessment') item = message({ summary: 'Ambos efectos observados', criteriaSatisfied: true, criteria: [{ requirement: 'Dos efectos únicos', status: 'met', evidence: 'Comandos observados y archivos persistidos' }] })
    else if (phase === 'review' || phase === 'closeout') item = message({ status: 'approved', summary: 'Efectos únicos comprobados', criteriaSatisfied: true, tasks: [],
      deliveryReview: { uiRequired: false, summary: 'Fixture nativo sin UI', reason: 'Solo archivos sintéticos', decisions: [], flows: [] },
      chatSummary: { done: 'Efectos aplicados.', tested: 'Comandos observados.', pending: 'Nada pendiente.' } })
    else if (prompt.includes('ROL:') || prompt.includes('ESTADO DEL EQUIPO')) {
      workerCalls++
      const objective = prompt.split('\nTAREA: ')[1]?.split('\nCRITERIOS:')[0] ?? ''
      assert.ok(objective.includes('.effect'), 'Worker objective must identify its owned effect')
      const id = objective.includes('fallback-pending.effect') ? 'fallback-pending' : 'fallback-done'
      if (outputs.length) {
        if (id === 'fallback-pending') while (!released) await delay(50)
        item = message({ status: 'completed', summary: 'Efecto único observado', checks: [commands[id]], limitations: [], chatSummary: { done: 'Efecto aplicado.', tested: 'Comando exitoso.', pending: 'Nada pendiente.' } })
      } else item = { type: 'function_call', id: `fc-${randomUUID()}`, call_id: `call-${randomUUID()}`, name: 'bash', arguments: JSON.stringify({ command: commands[id], description: 'Efecto único QA-FALLBACK', timeout: 10000 }), status: 'completed' }
    } else item = message({ action: 'work', reply: 'Empiezo', questions: [] })
    const events = [{ type: 'response.created', response: { id: 'resp', model: body.model, created_at: 0 } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', content: [], status: 'in_progress' } },
      ...(item.type === 'function_call' ? [{ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments }, { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments }] : [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }]),
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3 } } }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  } catch (error) { fixtureError = error; response.writeHead(500); response.end('Fixture failed') }
})
await new Promise(done => mock.listen(0, '127.0.0.1', done))
const reserve = tcpServer(); await new Promise(done => reserve.listen(0, '127.0.0.1', done))
const port = reserve.address().port; await new Promise(done => reserve.close(done))
const origin = `http://127.0.0.1:${port}`
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
Object.assign(env, { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root,
  XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'), OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_SERVER_PASSWORD: 'qa-password',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['openai'], provider: { openai: { npm: '@ai-sdk/openai', name: 'QA deterministic inference', whitelist: ['primary', 'secondary', 'tertiary'], options: { apiKey: 'test-fake', baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: Object.fromEntries(['primary', 'secondary', 'tertiary'].map(id => [id, { name: id, tool_call: true, reasoning: true, variants: { high: { reasoningEffort: 'high' } }, limit: { context: 200000, output: 16000 } }])) } }, agent: { title: { disable: true }, summary: { disable: true } } }) })
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
let app, engine, engineLog = ''
const kill = child => { if (child && child.exitCode === null) { assert.ok(child.pid > 0); try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* owned child may already have exited */ } } }
async function collect(child, logPath) {
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  await writeFile(logPath, log); assert.equal(code, 0, log); return log
}
try {
  engine = spawn(resolve('src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe'), ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: repo, windowsHide: true, stdio: 'pipe' })
  for (const stream of [engine.stdout, engine.stderr]) stream.on('data', bytes => { engineLog += bytes })
  const headers = { Authorization: `Basic ${Buffer.from('opencode:qa-password').toString('base64')}` }
  let healthy = false
  for (let i = 0; i < 150; i++) { try { healthy = (await fetch(origin + '/global/health', { headers, signal: AbortSignal.timeout(1000) })).ok } catch { /* starting */ } if (healthy) break; await delay(200) }
  assert.ok(healthy, engineLog)
  const catalogResponse = await fetch(origin + '/config/providers?directory=' + encodeURIComponent(repo), { headers, signal: AbortSignal.timeout(60000) })
  assert.equal(catalogResponse.status, 200, 'Effective model catalog unavailable')
  const catalog = await catalogResponse.json()
  const provider = catalog.providers?.find(provider => provider.id === 'openai')
  const sanitized = { providerID: provider?.id ?? null, baseURL: provider?.options?.baseURL ?? null, models: Object.entries(provider?.models ?? {}).map(([id, model]) => ({ id, variants: Object.keys(model.variants ?? {}), api: model.api ? { id: model.api.id, npm: model.api.npm } : null })) }
  await writeFile(join(root, 'catalog.json'), JSON.stringify(sanitized, null, 2))
  assert.equal(provider?.id, 'openai', 'Fixture must use an accepted provider')
  const expectedUrl = `http://127.0.0.1:${mock.address().port}/v1`
  assert.equal(provider?.options?.baseURL, expectedUrl, 'Provider must use only loopback inference')
  for (const id of ['primary', 'secondary', 'tertiary']) {
    const model = provider.models[id]
    assert.ok(model, `Missing synthetic model ${id}`)
    assert.ok(Object.hasOwn(model.variants ?? {}, 'high'), `Missing explicit high variant for ${id}`)
  }
  console.log(`PASS engine catalog: openai primary/secondary/tertiary, high variant and loopback endpoint. Evidence: ${root}`)
  if (!preflightOnly) {
  const build = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--lib', '--features', 'desktop-e2e', '--locked', '--no-run', '--message-format=json'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const built = await collect(build, join(root, 'build.log'))
  const executable = built.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }).find(item => item.executable && item.target?.name === 'app_lib')?.executable
  assert.ok(executable, 'Native Rust test executable not found')
  async function phase(name, terminate = false) {
    // Keep the real profile so Tauri can resolve app data, but isolate every
    // OpenCode read (auth, usage DB) under the synthetic profile root.
    const isolated = Object.fromEntries(['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','OPENCODE_CONFIG_DIR','OPENCODE_DISABLE_EXTERNAL_SKILLS','OPENCODE_DISABLE_PROJECT_CONFIG'].map(key => [key, env[key]]))
    app = spawn(executable, ['teams::integration::native_fallback_phase', '--ignored', '--exact', '--nocapture', '--test-threads=1'], { env: { ...process.env, ...isolated, GUILLE_TEAM_TEST_REPO: repo, GUILLE_TEAM_TEST_ENGINE: origin, GUILLE_FALLBACK_PHASE: name, GUILLE_FALLBACK_APP_ID: identifier, GUILLE_FALLBACK_REPORT: report }, windowsHide: true, stdio: 'pipe' })
    let log = ''; for (const stream of [app.stdout, app.stderr]) stream.on('data', bytes => { log += bytes })
    const exit = new Promise((done, reject) => { app.once('error', reject); app.once('exit', done) })
    const path = terminate ? `${report}.prepared.json` : name === 'reopen' ? `${report}.reopened.json` : report
    try {
      const deadline = Date.now() + 300000
      while (!await exists(path)) { if (fixtureError) throw fixtureError; assert.equal(app.exitCode, null, log); assert.ok(Date.now() < deadline, `Phase ${name} timed out: ${log}`); await delay(100) }
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (terminate) { kill(app); await exit } else assert.equal(await exit, 0, log)
      return value
    } finally { await writeFile(join(root, `${name}.log`), log) }
  }
  const prepared = await phase('prepare', true)
  released = true
  let idle = false
  for (let i = 0; i < 1200; i++) { const states = await fetch(origin + '/session/status?directory=' + encodeURIComponent(repo), { headers }).then(response => response.json()); idle = Object.values(states).every(state => state.type === 'idle'); if (idle) break; await delay(100) }
  assert.ok(idle, 'Engine did not settle after releasing inference')
  const count = workerCalls
  const resumed = await phase('resume')
  const reopened = await phase('reopen')
  assert.equal(workerCalls, count, 'Completed worker inference was replayed')
  for (const value of [resumed, reopened]) {
    assert.equal(value.status, 'completed'); assert.equal(value.runId, prepared.runId)
    assert.equal(value.planSessionId, prepared.planSessionId); assert.equal(value.snapshot.restored, true)
    assert.equal(value.snapshot.originalVariant, 'high'); assert.equal(value.snapshot.nextIndex, 2)
    assert.equal(value.chatLeadVariant, 'later-choice')
    for (const task of value.tasks) { const prior = prepared.tasks.find(old => old.id === task.id); assert.equal(task.attempts.length, 1); assert.equal(task.attempts[0].id, prior.attempts[0].id); assert.equal(task.attempts[0].sessionId, prior.attempts[0].sessionId) }
  }
  for (const id of Object.keys(commands)) assert.equal(await readFile(join(repo, `${id}.effect`), 'utf8'), 'once\n')
  assert.equal(await readFile(join(repo, 'user.txt'), 'utf8'), 'QA-FALLBACK preserved user work\n')
  console.log(`PASS native prepare/resume/reopen, ordered quota transitions, same sessions/attempts, once-only effects. Evidence: ${root}`)
  }
} finally {
  released = true; kill(app); kill(engine); mock.closeAllConnections(); await new Promise(done => mock.close(done))
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2))
  await writeFile(join(root, 'engine.log'), engineLog)
  if (appData) await rm(appData, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {})
}
