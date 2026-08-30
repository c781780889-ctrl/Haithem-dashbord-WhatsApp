import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Search, ArrowRight, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface CommandItem {
  id: string
  label: string
  section: string
  icon: LucideIcon
  to?: string
  action?: () => void
  keywords?: string
}

interface CommandPaletteProps {
  items: CommandItem[]
}

export function CommandPalette({ items }: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [])

  React.useEffect(() => {
    if (open) {
      setQuery("")
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const filtered = React.useMemo(() => {
    if (!query.trim()) return items
    const q = query.toLowerCase()
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.section.toLowerCase().includes(q) ||
        i.keywords?.toLowerCase().includes(q)
    )
  }, [items, query])

  const grouped = React.useMemo(() => {
    const map = new Map<string, CommandItem[]>()
    filtered.forEach((item) => {
      if (!map.has(item.section)) map.set(item.section, [])
      map.get(item.section)!.push(item)
    })
    return Array.from(map.entries())
  }, [filtered])

  function runItem(item: CommandItem) {
    setOpen(false)
    if (item.to) navigate(item.to)
    else item.action?.()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const item = filtered[activeIndex]
      if (item) runItem(item)
    }
  }

  if (!open) return null

  let flatIndex = -1

  return (
    <div
      className="fixed inset-0 z-[var(--z-command)] flex items-start justify-center pt-[12vh] px-4 bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="لوحة الأوامر"
    >
      <div
        className="w-full max-w-xl glass rounded-2xl shadow-[var(--shadow-floating)] overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-14 border-b border-[var(--border-default)]">
          <Search className="w-4.5 h-4.5 text-[var(--text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder="ابحث عن صفحة أو أمر..."
            className="flex-1 bg-transparent outline-none text-body-l text-primary placeholder:text-muted"
            aria-label="بحث"
          />
          <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[10px] font-mono border border-[var(--border-strong)] text-muted">
            ESC
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {grouped.length === 0 && (
            <div className="py-10 text-center text-body-s text-muted">لا توجد نتائج مطابقة</div>
          )}
          {grouped.map(([section, sectionItems]) => (
            <div key={section} className="mb-2">
              <div className="text-label text-muted px-3 py-1.5">{section}</div>
              {sectionItems.map((item) => {
                flatIndex++
                const isActive = flatIndex === activeIndex
                return (
                  <button
                    key={item.id}
                    onClick={() => runItem(item)}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-right transition-colors",
                      isActive ? "bg-[var(--brand-primary)] text-white" : "text-primary hover:bg-[var(--bg-hover)]"
                    )}
                  >
                    <item.icon className={cn("w-4 h-4 shrink-0", isActive ? "text-white" : "text-[var(--text-muted)]")} />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <ArrowRight className="w-3.5 h-3.5 icon-directional" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
