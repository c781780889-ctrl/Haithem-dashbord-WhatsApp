import * as React from "react"
import { Check, Minus } from "lucide-react"
import { cn } from "@/lib/utils"

export interface CheckboxProps {
  checked: boolean | "indeterminate"
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, onCheckedChange, disabled, id, className, ...aria }, ref) => {
    const isIndeterminate = checked === "indeterminate"
    const isChecked = checked === true

    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="checkbox"
        aria-checked={isIndeterminate ? "mixed" : isChecked}
        disabled={disabled}
        onClick={() => onCheckedChange(!isChecked)}
        className={cn(
          "peer inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-all duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-app)]",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          isChecked || isIndeterminate
            ? "bg-[var(--brand-primary)] border-[var(--brand-primary)] text-[var(--text-on-brand)]"
            : "bg-[var(--bg-elevated)] border-[var(--border-strong)] hover:border-[var(--brand-primary-600)]",
          className
        )}
        {...aria}
      >
        {isIndeterminate ? (
          <Minus className="h-3.5 w-3.5" strokeWidth={3} />
        ) : isChecked ? (
          <Check className="h-3.5 w-3.5 animate-scale-in" strokeWidth={3} />
        ) : null}
      </button>
    )
  }
)
Checkbox.displayName = "Checkbox"

export { Checkbox }
