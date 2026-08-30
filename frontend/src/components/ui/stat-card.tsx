import * as React from "react"
import { type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "./card"

interface StatCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  change?: string
  changeDirection?: "up" | "down" | "neutral"
  progress?: number
  color?: string
  className?: string
}

export function StatCard({
  title,
  value,
  icon: Icon,
  change,
  changeDirection = "neutral",
  progress,
  color = "var(--brand-primary)",
  className,
}: StatCardProps) {
  const changeColor =
    changeDirection === "up" ? "text-[var(--success)]" :
    changeDirection === "down" ? "text-[var(--danger)]" :
    "text-[var(--text-muted)]"

  return (
    <Card hoverMotion className={className}>
      <CardContent className="p-5 flex flex-col gap-4">
        <div className="flex justify-between items-start">
          <div
            className="p-2.5 rounded-xl"
            style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
          >
            <Icon className="w-5 h-5" style={{ color }} />
          </div>
          {change && (
            <span className={cn("text-xs font-semibold px-2 py-1 rounded-md bg-[var(--bg-elevated)]", changeColor)}>
              {change}
            </span>
          )}
        </div>
        <div>
          <p className="text-secondary text-sm font-medium">{title}</p>
          <h3 className="text-2xl font-bold text-primary mt-1">{value}</h3>
        </div>
        {typeof progress === "number" && (
          <div className="w-full h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${color}, var(--brand-secondary))` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
