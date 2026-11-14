import type { ReactNode } from "react"
import { useLayout } from "../state/layout"

/** Central content area of a studio mode. Hides only this column when the lower
 * panel is maximized, leaving the mode's side surfaces visible. */
export function StudioCenterMain({ children, className }: { children: ReactNode; className?: string }) {
  const hidden = useLayout(s => s.panelVisible && s.panelMaximized)
  return <div className={`studio-center-main${className ? ` ${className}` : ""}`} hidden={hidden}>{children}</div>
}
