import * as React from "react"
import { ChevronLeft, MoreHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"

export interface BreadcrumbItem {
  label: string
  href?: string
  onClick?: () => void
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[]
  className?: string
  /** Collapse middle items into a "…" when more than this many items exist */
  maxVisible?: number
}

const Breadcrumb = React.forwardRef<HTMLElement, BreadcrumbProps>(
  ({ items, className, maxVisible = 4 }, ref) => {
    const shouldCollapse = items.length > maxVisible
    const visibleItems = shouldCollapse
      ? [items[0], { label: "…", collapsed: true } as BreadcrumbItem & { collapsed: boolean }, ...items.slice(-2)]
      : items

    return (
      <nav ref={ref} aria-label="Breadcrumb" className={cn("flex items-center", className)}>
        <ol className="flex items-center gap-1.5 text-sm">
          {visibleItems.map((item, i) => {
            const isLast = i === visibleItems.length - 1
            const isCollapsed = (item as { collapsed?: boolean }).collapsed

            return (
              <li key={i} className="flex items-center gap-1.5">
                {i > 0 && (
                  <ChevronLeft className="h-3.5 w-3.5 text-[var(--text-muted)] rtl:rotate-0" aria-hidden="true" />
                )}
                {isCollapsed ? (
                  <MoreHorizontal className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
                ) : isLast || (!item.href && !item.onClick) ? (
                  <span
                    className={cn(
                      "font-medium",
                      isLast ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
                    )}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {item.label}
                  </span>
                ) : (
                  <button
                    onClick={item.onClick}
                    className="text-[var(--text-muted)] hover:text-[var(--brand-primary)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] rounded-sm"
                  >
                    {item.label}
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      </nav>
    )
  }
)
Breadcrumb.displayName = "Breadcrumb"

export { Breadcrumb }
