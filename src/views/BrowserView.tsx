import { BrowserPane } from "../team/BrowserPane"

// Navegador compartido de los Flufy Bots: mismo perfil para todos, separado del
// Chrome personal. Las páginas de cada misión aparecen acá mientras trabajan.
export function BrowserView() {
  return (
    <div className="browser-editor">
      <BrowserPane session="bots" />
    </div>
  )
}
