import * as React from "react"
import { type LucideIcon, Inbox } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
  variant?: "default" | "error" | "success"
  className?: string
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actionLabel,
  onAction,
  variant = "default",
  className,
}: EmptyStateProps) {
  const iconColors = {
    default: "text-[var(--text-muted)] bg-[var(--bg-elevated)]",
    error: "text-[var(--danger)] bg-[var(--danger-bg)]",
    success: "text-[var(--success)] bg-[var(--success-bg)]",
  }

  return (
    <div className={cn("flex flex-col items-center justify-center text-center py-16 px-6 animate-fade-in", className)}>
      <div className={cn("w-16 h-16 rounded-2xl flex items-center justify-center mb-5", iconColors[variant])}>
        <Icon className="w-7 h-7" />
      </div>
      <h3 className="text-heading-s text-primary mb-1.5">{title}</h3>
      {description && (
        <p className="text-body-s text-secondary max-w-sm mb-6">{description}</p>
      )}
      {actionLabel && onAction && (
        <Button onClick={onAction} size="sm">{actionLabel}</Button>
      )}
    </div>
  )
}
