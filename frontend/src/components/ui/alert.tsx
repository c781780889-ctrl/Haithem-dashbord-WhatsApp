import * as React from "react"
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react"
import { cn } from "@/lib/utils"

type AlertVariant = "info" | "success" | "warning" | "danger"

const variantConfig: Record<AlertVariant, { icon: React.ElementType; color: string; bg: string; border: string }> = {
  info: { icon: Info, color: "var(--info)", bg: "var(--info-bg)", border: "rgba(59,130,246,0.25)" },
  success: { icon: CheckCircle2, color: "var(--success)", bg: "var(--success-bg)", border: "rgba(34,197,94,0.25)" },
  warning: { icon: AlertTriangle, color: "var(--warning)", bg: "var(--warning-bg)", border: "rgba(245,158,11,0.25)" },
  danger: { icon: XCircle, color: "var(--danger)", bg: "var(--danger-bg)", border: "rgba(239,68,68,0.25)" },
}

export interface AlertProps {
  variant?: AlertVariant
  title?: string
  children?: React.ReactNode
  onDismiss?: () => void
  className?: string
  action?: React.ReactNode
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ variant = "info", title, children, onDismiss, action, className }, ref) => {
    const config = variantConfig[variant]
    const Icon = config.icon

    return (
      <div
        ref={ref}
        role="alert"
        className={cn(
          "flex gap-3 rounded-[var(--radius-lg)] border p-4 animate-fade-in",
          className
        )}
        style={{ backgroundColor: config.bg, borderColor: config.border }}
      >
        <Icon className="h-5 w-5 shrink-0 mt-0.5" style={{ color: config.color }} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          {title && (
            <p className="text-sm font-semibold" style={{ color: config.color }}>
              {title}
            </p>
          )}
          {children && (
            <div className={cn("text-sm text-[var(--text-secondary)]", title && "mt-1")}>
              {children}
            </div>
          )}
          {action && <div className="mt-3">{action}</div>}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="إغلاق التنبيه"
            className="shrink-0 rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    )
  }
)
Alert.displayName = "Alert"

export { Alert }
export type { AlertVariant }
