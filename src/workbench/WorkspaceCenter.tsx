import { type ReactNode } from "react"
import { useLayout } from "../state/layout"
import { WorkspacePanel } from "./WorkspacePanel"

/** The lower panel belongs to the workspace, not to the code editor. Each
 * surface renders it under its own central column. */
export function WorkspaceCenter({ children, hasProject, showPanel = true }: { children: ReactNode; hasProject: boolean; showPanel?: boolean }) {
  const visible = useLayout(s => s.panelVisible) && hasProject && showPanel
  const maximized = useLayout(s => s.panelMaximized)
  return <div className="center workspace-center">
    <div className="workspace-content" hidden={visible && maximized}>{children}</div>
    {visible && <WorkspacePanel />}
  </div>
}
