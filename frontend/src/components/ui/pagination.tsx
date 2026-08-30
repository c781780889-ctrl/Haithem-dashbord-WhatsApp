import * as React from "react"
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"

export interface PaginationProps {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  className?: string
  /** Total item count — shown as "عرض X–Y من Z" when provided together with pageSize */
  totalItems?: number
  pageSize?: number
}

function getPageList(page: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const pages = new Set<number>([1, totalPages, page, page - 1, page + 1])
  const sorted = Array.from(pages).filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b)
  const result: (number | "ellipsis")[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - (sorted[i - 1] as number) > 1) result.push("ellipsis")
    result.push(p)
  })
  return result
}

/**
 * Standard pagination control for data tables (Groups, Campaigns, Admin Stats).
 * RTL-aware: "previous" points right, "next" points left, matching reading direction.
 */
const Pagination = React.forwardRef<HTMLDivElement, PaginationProps>(
  ({ page, totalPages, onPageChange, className, totalItems, pageSize }, ref) => {
    if (totalPages <= 1) return null
    const pages = getPageList(page, totalPages)

    const rangeStart = pageSize ? (page - 1) * pageSize + 1 : undefined
    const rangeEnd = pageSize && totalItems ? Math.min(page * pageSize, totalItems) : undefined

    return (
      <div
        ref={ref}
        className={cn("flex items-center justify-between gap-4 flex-wrap", className)}
        role="navigation"
        aria-label="ترقيم الصفحات"
      >
        {totalItems !== undefined && rangeStart !== undefined && (
          <p className="text-body-s text-muted">
            عرض {rangeStart}–{rangeEnd} من {totalItems}
          </p>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="الصفحة السابقة"
          >
            <ChevronRight className="h-4 w-4 icon-directional" />
          </Button>

          {pages.map((p, i) =>
            p === "ellipsis" ? (
              <span key={`e-${i}`} className="flex h-8 w-8 items-center justify-center text-muted">
                <MoreHorizontal className="h-4 w-4" />
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "ghost"}
                size="icon-sm"
                onClick={() => onPageChange(p)}
                aria-current={p === page ? "page" : undefined}
                aria-label={`الصفحة ${p}`}
              >
                {p}
              </Button>
            )
          )}

          <Button
            variant="outline"
            size="icon-sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="الصفحة التالية"
          >
            <ChevronLeft className="h-4 w-4 icon-directional" />
          </Button>
        </div>
      </div>
    )
  }
)
Pagination.displayName = "Pagination"

export { Pagination }
