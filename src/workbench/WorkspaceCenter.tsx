import { useRef, type ReactNode } from "react"
import { useLayout } from "../state/layout"
import { Sash } from "../components/Sash"
import { Panel } from "./Panel"

/** The lower panel belongs to the workspace, not to the code editor. Keeping
 * this container stable lets every studio mode reveal the same terminals. */
export function WorkspaceCenter({ children, hasProject }: { children: ReactNode; hasProject: boolean }) {
  const visible = useLayout(s => s.panelVisible) && hasProject
  const height = useLayout(s => s.panelHeight)
  const maximized = useLayout(s => s.panelMaximized)
  const start = useRef<number | null>(null)
  return <div className="center workspace-center">
    <div className="workspace-content" hidden={visible && maximized}>{children}</div>
    {visible && <>
      {!maximized && <Sash orientation="horizontal"
        onDrag={delta => {
          start.current ??= useLayout.getState().panelHeight
          useLayout.getState().setPanelHeight(start.current - delta)
        }}
        onDragEnd={() => { start.current = null }}
        onDoubleClick={() => useLayout.getState().togglePanelMaximized()} />}
      <div className="panel-slot" style={maximized ? { flex: 1 } : { height }}>
        <Panel />
      </div>
    </>}
  </div>
}
