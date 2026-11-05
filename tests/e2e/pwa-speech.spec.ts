import { expect, test, type Page } from "@playwright/test"

const project = "C:/qa/pwa-speech"
const sessionID = "ses_speech"
const now = Date.now()

function silentWav(samples = 4410): Buffer {
  const data = samples * 2
  const wav = Buffer.alloc(44 + data)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(36 + data, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(22_050, 24)
  wav.writeUInt32LE(44_100, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(data, 40)
  return wav
}

async function emit(page: Page, event: unknown) {
  await page.evaluate((value) => (window as unknown as { emitLive: (event: unknown) => void }).emitLive(value), event)
}

test("sintetiza cada frase mientras el texto sigue llegando", async ({ page }) => {
  const segments: Array<{ index: number; text: string }> = []
  const wav = silentWav()
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flufy.voice.mode.ses_speech", "on")
    } catch {
      /* contexto sin storage */
    }
  })
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input).startsWith("/hub/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            Object.assign(window, { emitLive: (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) })
            controller.enqueue(new TextEncoder().encode(": ok\n\n"))
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true })
          },
        })
        return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }))
      }
      return fetch(input, init)
    }
  })
  await page.route("**/hub/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/hub/speech") {
      return route.fulfill({ json: {
        available: true, ready: true, enabled: true, voice: "test", speed: 1,
        defaultVoice: "test", voicesDir: null, worker: false, workerRunning: false, voices: [],
      } })
    }
    if (path === "/hub/speech/notes") return route.fulfill({ json: {} })
    if (path === "/hub/speech/segment") {
      segments.push(route.request().postDataJSON())
      return route.fulfill({ body: wav, contentType: "audio/wav" })
    }
    return route.fulfill({ json: {
      current: project, projects: [project], routines: [],
      prefs: { model: { providerID: "openai", modelID: "model" }, agent: "build" },
    } })
  })
  await page.route("**/oc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/oc", "")
    if (path === "/config/providers") return route.fulfill({ json: {
      providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { model: { id: "model", name: "Test model" } } }],
    } })
    if (path === "/session/status") return route.fulfill({ json: { [sessionID]: { type: "busy" } } })
    if (path === `/session/${sessionID}`) return route.fulfill({ json: { id: sessionID, title: "Voz en vivo", time: { created: now, updated: now } } })
    return route.fulfill({ json: [] })
  })
  await page.route("**/live-test", (route) => route.fulfill({ contentType: "text/html", body: `
    <div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/pwa/pwa.css');
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { SessionScreen } = await import('/src/pwa/Session.tsx');
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(SessionScreen, {
        route: { kind: 'session', id: '${sessionID}', project: '${project}', title: 'Voz en vivo' },
        back: () => { throw new Error('La prueba no debe salir de la conversación'); },
      }));
    </script>
  ` }))
  await page.goto("/live-test", { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Test model", { exact: true })).toBeVisible({ timeout: 60000 })

  const info = { id: "msg_asst", sessionID, role: "assistant", time: { created: now + 1 } }
  const part = { id: "prt_asst", messageID: "msg_asst", sessionID, type: "text", text: "", time: { start: now + 2 } }
  await emit(page, { type: "message.updated", properties: { info } })
  await emit(page, { type: "message.part.updated", properties: { part } })
  await emit(page, {
    type: "message.part.delta",
    properties: { sessionID, messageID: "msg_asst", partID: "prt_asst", field: "text", delta: "Ya delegué la revisión completa del proyecto a un subagente. " },
  })
  await expect.poll(() => segments.length).toBe(1)
  expect(segments[0].index).toBe(0)
  expect(segments[0].text).toContain("Ya delegué la revisión")

  // La parte todavía está abierta: el segundo segmento se pide igual.
  await emit(page, {
    type: "message.part.delta",
    properties: { sessionID, messageID: "msg_asst", partID: "prt_asst", field: "text", delta: "Te aviso cuando termine y te cuento cómo quedó. " },
  })
  await expect.poll(() => segments.length).toBe(2)
  expect(segments[1].index).toBe(1)
  expect(segments[1].text).toContain("Te aviso cuando termine")

  await emit(page, {
    type: "message.part.updated",
    properties: { part: { ...part, text: "Ya delegué la revisión completa del proyecto a un subagente. Te aviso cuando termine y te cuento cómo quedó.", time: { start: now + 2, end: now + 3 } } },
  })
  await page.waitForTimeout(500)
  expect(segments).toHaveLength(2)
})
