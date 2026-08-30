import * as React from "react"
import { cn } from "@/lib/utils"

export type StatusDotState = "live" | "pending" | "error" | "idle"

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  state: StatusDotState
  pulse?: boolean
  label?: string
}

/**
 * Connection/sync status indicator. Consumes the `.status-dot*` CSS classes
 * from index.css (Stage 0). Used across Accounts, Groups, Diagnostics views
 * wherever a live/pending/error/idle state needs a compact visual.
 */
const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ className, state, pulse = state === "live", label, ...props }, ref) => (
    <span
      ref={ref}
      role={label ? "status" : undefined}
      aria-label={label}
      className={cn("status-dot", `status-dot-${state}`, pulse && "status-dot-pulse", className)}
      {...props}
    />
  )
)
StatusDot.displayName = "StatusDot"

export interface StatusLabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  state: StatusDotState
  children: React.ReactNode
}

/** StatusDot + text label, the common pairing across list rows. */
const StatusLabel = React.forwardRef<HTMLSpanElement, StatusLabelProps>(
  ({ className, state, children, ...props }, ref) => (
    <span ref={ref} className={cn("inline-flex items-center gap-2 text-sm", className)} {...props}>
      <StatusDot state={state} />
      <span className="text-secondary">{children}</span>
    </span>
  )
)
StatusLabel.displayName = "StatusLabel"

export { StatusDot, StatusLabel }
