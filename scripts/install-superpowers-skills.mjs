import { readFile, mkdir, lstat, writeFile, realpath } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../.opencode/skills")
export const revision = "22f0b463e7a5e579904dd6211a520321035526f7"
export const available = JSON.parse(await readFile(join(source, "superpowers-catalog.json"), "utf8"))

async function exists(path) {
  try { return await lstat(path) } catch (error) { if (error.code === "ENOENT") return null; throw error }
}

// No plugin, network fetch, global config or bootstrap. Use the reviewed,
// revision-pinned project documents; never replace a personalized skill.
export async function installSkills(project, ids) {
  if (!ids.length) throw new Error("Seleccioná al menos una skill; usá --list para ver las disponibles.")
  const selected = [...new Set(ids)].map(id => {
    const skill = available.find(skill => skill.id === id || skill.id === `superpowers-${id}`)
    if (!skill) throw new Error(`Skill no ofrecida: ${id}`)
    return skill
  })
  const root = await realpath(project)
  const destinations = [join(root, ".opencode"), join(root, ".opencode", "skills")]
  const pending = []
  const result = []
  for (const skill of selected) {
    const target = join(destinations[1], skill.slug)
    for (const path of [...destinations, target]) {
      const stat = await exists(path)
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Destino no es una carpeta local: ${path}`)
    }
    let changed = false
    for (const file of ["SKILL.md", "LICENSE"]) {
      const content = await readFile(join(source, skill.slug, file))
      const path = join(target, file)
      const stat = await exists(path)
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(path)).equals(content)) {
          throw new Error(`Se preservó contenido personalizado: ${path}. Elegí otro proyecto o revisá la versión manualmente.`)
        }
      } else { pending.push({ target, path, content }); changed = true }
    }
    result.push({ id: skill.id, version: skill.version, revision, status: changed ? "installed" : "unchanged" })
  }
  // Validate every selection and conflict before touching the destination.
  for (const file of pending) {
    await mkdir(file.target, { recursive: true })
    await writeFile(file.path, file.content, { flag: "wx" })
  }
  return result
}

async function main(args) {
  if (args.length === 1 && args[0] === "--list") {
    console.log(JSON.stringify({ repository: "https://github.com/obra/superpowers", revision, license: "MIT", skills: available }, null, 2))
    return
  }
  let project = process.cwd()
  const ids = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") {
      if (!args[i + 1]) throw new Error("Falta la carpeta de --project")
      project = resolve(args[++i])
    } else if (args[i].startsWith("--")) throw new Error(`Opción desconocida: ${args[i]}`)
    else ids.push(args[i])
  }
  console.log(JSON.stringify(await installSkills(project, ids), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
