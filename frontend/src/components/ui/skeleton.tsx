import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-md skeleton-shimmer", className)}
      {...props}
    />
  )
}

function SkeletonRow({ columns = 4 }: { columns?: number }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-[var(--border-default)]">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i === 0 ? "w-8 h-8 rounded-full" : "flex-1")} />
      ))}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex justify-between">
        <Skeleton className="w-10 h-10 rounded-xl" />
        <Skeleton className="w-12 h-5 rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="w-24 h-3" />
        <Skeleton className="w-16 h-6" />
      </div>
      <Skeleton className="w-full h-1.5 rounded-full" />
    </div>
  )
}

export { Skeleton, SkeletonRow, SkeletonCard }
