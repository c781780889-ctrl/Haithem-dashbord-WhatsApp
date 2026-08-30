import * as React from "react"
import { cn } from "@/lib/utils"

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl"
type AvatarStatus = "online" | "offline" | "away" | "busy"

const sizeMap: Record<AvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-16 w-16 text-lg",
}

const statusColor: Record<AvatarStatus, string> = {
  online: "var(--success)",
  offline: "var(--text-muted)",
  away: "var(--warning)",
  busy: "var(--danger)",
}

const statusSize: Record<AvatarSize, string> = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
  xl: "h-3.5 w-3.5",
}

export interface AvatarProps {
  src?: string
  name?: string
  size?: AvatarSize
  status?: AvatarStatus
  className?: string
}

function getInitials(name?: string) {
  if (!name) return "؟"
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

// Deterministic hue from name so the same person always gets the same color
function hueFromName(name?: string) {
  if (!name) return 220
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return Math.abs(hash) % 360
}

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ src, name, size = "md", status, className }, ref) => {
    const [imgError, setImgError] = React.useState(false)
    const hue = hueFromName(name)

    return (
      <div
        ref={ref}
        className={cn("relative inline-flex shrink-0 rounded-full", sizeMap[size], className)}
      >
        {src && !imgError ? (
          <img
            src={src}
            alt={name ?? "صورة المستخدم"}
            onError={() => setImgError(true)}
            loading="lazy"
            decoding="async"
            className="h-full w-full rounded-full object-cover border border-[var(--border-default)]"
          />
        ) : (
          <div
            className="h-full w-full rounded-full flex items-center justify-center font-semibold border border-[var(--border-default)]"
            style={{
              backgroundColor: `hsl(${hue}, 70%, 20%)`,
              color: `hsl(${hue}, 85%, 75%)`,
            }}
            aria-hidden="true"
          >
            {getInitials(name)}
          </div>
        )}
        {status && (
          <span
            className={cn(
              "absolute bottom-0 left-0 rounded-full border-2 border-[var(--bg-surface)]",
              statusSize[size]
            )}
            style={{ backgroundColor: statusColor[status] }}
            aria-label={`الحالة: ${status}`}
          />
        )}
      </div>
    )
  }
)
Avatar.displayName = "Avatar"

export { Avatar }
export type { AvatarSize, AvatarStatus }
