import { useRef } from "react"
import { useLayout } from "../state/layout"
import { Sash } from "../components/Sash"
import { Panel } from "./Panel"

/** Shared lower panel: the terminal and output stay mounted while each surface
 * places them under its own central column. */
export function WorkspacePanel() {
  const height = useLayout(s => s.sizes.panelHeight)
  const maximized = useLayout(s => s.panelMaximized)
  const start = useRef<number | null>(null)
  return <>
    {!maximized && <Sash orientation="horizontal"
      onDrag={delta => {
        start.current ??= useLayout.getState().sizes.panelHeight
        useLayout.getState().setPanelHeight(start.current - delta)
      }}
      onDragEnd={() => { start.current = null }}
      onDoubleClick={() => useLayout.getState().togglePanelMaximized()} />}
    <div className="panel-slot" style={maximized ? { flex: 1 } : { height }}>
      <Panel />
    </div>
  </>
}
