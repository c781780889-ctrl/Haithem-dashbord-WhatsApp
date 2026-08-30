import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "whitespace-nowrap inline-flex items-center gap-1 rounded-md border px-2.5 py-0.5 text-xs font-semibold " +
  "transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover-elevate",
  {
    variants: {
      variant: {
        default:  "border-transparent bg-primary text-primary-foreground shadow-xs",
        secondary:"border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow-xs",
        outline: "text-foreground border [border-color:var(--badge-outline)]",
        success: "border-transparent bg-[var(--success-bg)] text-[var(--success)]",
        warning: "border-transparent bg-[var(--warning-bg)] text-[var(--warning)]",
        danger:  "border-transparent bg-[var(--danger-bg)] text-[var(--danger)]",
        info:    "border-transparent bg-[var(--info-bg)] text-[var(--info)]",
        soft:    "border-transparent bg-[var(--brand-primary-light)] text-[var(--brand-primary)]",
      },
      size: {
        default: "text-xs px-2.5 py-0.5",
        sm: "text-[10px] px-2 py-0.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean
}

function Badge({ className, variant, size, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />}
      {children}
    </div>
  )
}

export { Badge, badgeVariants }
