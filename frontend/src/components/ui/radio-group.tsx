import * as React from "react"
import { cn } from "@/lib/utils"

export interface RadioGroupProps {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  className?: string
  name?: string
  disabled?: boolean
}

interface RadioGroupContextValue {
  value: string
  onValueChange: (value: string) => void
  name?: string
  disabled?: boolean
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null)

const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ value, onValueChange, children, className, name, disabled }, ref) => (
    <RadioGroupContext.Provider value={{ value, onValueChange, name, disabled }}>
      <div ref={ref} role="radiogroup" className={cn("flex flex-col gap-3", className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
)
RadioGroup.displayName = "RadioGroup"

export interface RadioGroupItemProps {
  value: string
  id?: string
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

const RadioGroupItem = React.forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  ({ value, id, disabled, className, ...aria }, ref) => {
    const ctx = React.useContext(RadioGroupContext)
    if (!ctx) throw new Error("RadioGroupItem must be used within RadioGroup")

    const isSelected = ctx.value === value
    const isDisabled = disabled ?? ctx.disabled

    return (
      <button
        ref={ref}
        id={id}
        type="button"
        role="radio"
        aria-checked={isSelected}
        disabled={isDisabled}
        onClick={() => ctx.onValueChange(value)}
        className={cn(
          "relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-app)]",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          isSelected
            ? "border-[var(--brand-primary)]"
            : "border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:border-[var(--brand-primary-600)]",
          className
        )}
        {...aria}
      >
        {isSelected && (
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--brand-primary)] animate-scale-in" />
        )}
      </button>
    )
  }
)
RadioGroupItem.displayName = "RadioGroupItem"

export { RadioGroup, RadioGroupItem }
