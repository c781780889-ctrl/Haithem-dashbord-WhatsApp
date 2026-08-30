import * as React from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

export type ChipVariant = "default" | "brand" | "accent" | "success" | "warning" | "danger"

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant
  interactive?: boolean
  onRemove?: () => void
  removeLabel?: string
}

/**
 * Chip / Tag primitive. Consumes the `.chip*` CSS classes defined in index.css
 * (Stage 0). Used for filter tags, keyword lists, campaign labels, group tags.
 */
const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(
  ({ className, variant = "default", interactive, onRemove, removeLabel = "إزالة", children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          "chip",
          variant !== "default" && `chip-${variant}`,
          interactive && "chip-interactive",
          onRemove && "chip-removable",
          className
        )}
        {...props}
      >
        {children}
        {onRemove && (
          <button
            type="button"
            className="chip-remove-btn"
            aria-label={removeLabel}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
    )
  }
)
Chip.displayName = "Chip"

export interface ChipGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Max chips to show before collapsing into "+N" */
  maxVisible?: number
}

/**
 * Lays out a list of Chip children with automatic overflow collapse
 * (e.g. group tag lists in GroupsView, keyword lists in KeywordMonitoringView).
 */
const ChipGroup = React.forwardRef<HTMLDivElement, ChipGroupProps>(
  ({ className, children, maxVisible, ...props }, ref) => {
    const items = React.Children.toArray(children)
    const visible = maxVisible ? items.slice(0, maxVisible) : items
    const hiddenCount = maxVisible ? Math.max(0, items.length - maxVisible) : 0

    return (
      <div ref={ref} className={cn("flex flex-wrap items-center gap-1.5", className)} {...props}>
        {visible}
        {hiddenCount > 0 && <span className="chip">+{hiddenCount}</span>}
      </div>
    )
  }
)
ChipGroup.displayName = "ChipGroup"

export { Chip, ChipGroup }
