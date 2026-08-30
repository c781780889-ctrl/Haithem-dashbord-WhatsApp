import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

interface AccordionContextValue {
  openItems: Set<string>
  toggle: (value: string) => void
}
const AccordionContext = React.createContext<AccordionContextValue | null>(null)

export interface AccordionProps {
  type?: "single" | "multiple"
  defaultValue?: string | string[]
  children: React.ReactNode
  className?: string
}

const Accordion = React.forwardRef<HTMLDivElement, AccordionProps>(
  ({ type = "single", defaultValue, children, className }, ref) => {
    const initial = new Set(
      Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : []
    )
    const [openItems, setOpenItems] = React.useState<Set<string>>(initial)

    const toggle = React.useCallback(
      (value: string) => {
        setOpenItems((prev) => {
          const next = new Set(type === "single" ? [] : prev)
          if (prev.has(value)) {
            next.delete(value)
          } else {
            next.add(value)
          }
          return next
        })
      },
      [type]
    )

    return (
      <AccordionContext.Provider value={{ openItems, toggle }}>
        <div ref={ref} className={cn("flex flex-col divide-y divide-[var(--border-default)]", className)}>
          {children}
        </div>
      </AccordionContext.Provider>
    )
  }
)
Accordion.displayName = "Accordion"

interface AccordionItemContextValue {
  value: string
}
const AccordionItemContext = React.createContext<AccordionItemContextValue | null>(null)

export interface AccordionItemProps {
  value: string
  children: React.ReactNode
  className?: string
}

const AccordionItem = React.forwardRef<HTMLDivElement, AccordionItemProps>(
  ({ value, children, className }, ref) => (
    <AccordionItemContext.Provider value={{ value }}>
      <div ref={ref} className={cn("py-1", className)}>
        {children}
      </div>
    </AccordionItemContext.Provider>
  )
)
AccordionItem.displayName = "AccordionItem"

export interface AccordionTriggerProps {
  children: React.ReactNode
  className?: string
}

const AccordionTrigger = React.forwardRef<HTMLButtonElement, AccordionTriggerProps>(
  ({ children, className }, ref) => {
    const ctx = React.useContext(AccordionContext)
    const itemCtx = React.useContext(AccordionItemContext)
    if (!ctx || !itemCtx) throw new Error("AccordionTrigger must be used within AccordionItem")

    const isOpen = ctx.openItems.has(itemCtx.value)
    const contentId = `accordion-content-${itemCtx.value}`

    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => ctx.toggle(itemCtx.value)}
        className={cn(
          "flex w-full items-center justify-between gap-2 py-3 text-sm font-medium text-start transition-colors",
          "text-[var(--text-primary)] hover:text-[var(--brand-primary)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] rounded-[var(--radius-sm)]",
          className
        )}
      >
        {children}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>
    )
  }
)
AccordionTrigger.displayName = "AccordionTrigger"

export interface AccordionContentProps {
  children: React.ReactNode
  className?: string
}

const AccordionContent = React.forwardRef<HTMLDivElement, AccordionContentProps>(
  ({ children, className }, ref) => {
    const ctx = React.useContext(AccordionContext)
    const itemCtx = React.useContext(AccordionItemContext)
    if (!ctx || !itemCtx) throw new Error("AccordionContent must be used within AccordionItem")

    const isOpen = ctx.openItems.has(itemCtx.value)
    const contentId = `accordion-content-${itemCtx.value}`

    return (
      <div
        ref={ref}
        id={contentId}
        role="region"
        className={cn(
          "grid overflow-hidden transition-all duration-200 ease-[var(--ease-standard)]",
          isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden">
          <div className={cn("pb-3 text-sm text-[var(--text-secondary)]", className)}>{children}</div>
        </div>
      </div>
    )
  }
)
AccordionContent.displayName = "AccordionContent"

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
