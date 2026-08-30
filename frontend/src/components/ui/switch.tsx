import * as React from "react"
import { cn } from "@/lib/utils"

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, id, className, ...aria }, ref) => (
    <button
      ref={ref}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-app)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-[var(--brand-primary)]" : "bg-[var(--bg-elevated)] border border-[var(--border-strong)]",
        className
      )}
      {...aria}
    >
      <span
        className="inline-block rounded-full bg-white shadow-md transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{
          width: '1.125rem',
          height: '1.125rem',
          marginInlineStart: checked ? 'calc(100% - 1.125rem - 2px)' : '2px',
        }}
      />
    </button>
  )
)
Switch.displayName = "Switch"

export { Switch }
