import * as React from "react"
import { UploadCloud, File as FileIcon, X, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export interface FileUploadProps {
  accept?: string
  multiple?: boolean
  maxSizeMb?: number
  onFilesSelected: (files: File[]) => void
  className?: string
  hint?: string
  disabled?: boolean
}

/**
 * Drag-and-drop file upload zone. Used by AdLibraryView (creative assets)
 * and account import flows. Was entirely absent from the component set
 * despite being listed as a required Enterprise component.
 */
const FileUpload = React.forwardRef<HTMLDivElement, FileUploadProps>(
  ({ accept, multiple = false, maxSizeMb = 25, onFilesSelected, className, hint, disabled }, ref) => {
    const [isDragging, setIsDragging] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const inputRef = React.useRef<HTMLInputElement>(null)

    const processFiles = (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      setError(null)
      const files = Array.from(fileList)
      const tooLarge = files.find((f) => f.size > maxSizeMb * 1024 * 1024)
      if (tooLarge) {
        setError(`الملف "${tooLarge.name}" أكبر من الحد المسموح (${maxSizeMb} ميجابايت)`)
        return
      }
      onFilesSelected(multiple ? files : [files[0]])
    }

    return (
      <div ref={ref} className={cn("flex flex-col gap-2", className)}>
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={() => !disabled && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (!disabled && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          onDragOver={(e) => {
            e.preventDefault()
            if (!disabled) setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setIsDragging(false)
            if (!disabled) processFiles(e.dataTransfer.files)
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-[var(--radius-xl)] border-2 border-dashed p-8 text-center transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-app)]",
            isDragging
              ? "border-[var(--brand-primary)] bg-[var(--brand-primary-light)]"
              : "border-[var(--border-strong)] hover:border-[var(--text-muted)] bg-[var(--bg-elevated)]",
            disabled && "opacity-50 cursor-not-allowed pointer-events-none"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            multiple={multiple}
            disabled={disabled}
            className="sr-only"
            onChange={(e) => processFiles(e.target.files)}
          />
          <UploadCloud className="h-8 w-8 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-body-m text-primary font-medium">
            اسحب الملفات هنا أو <span className="text-[var(--brand-primary)]">تصفح</span>
          </p>
          {hint && <p className="text-body-s text-muted">{hint}</p>}
        </div>
        {error && (
          <p className="flex items-center gap-1.5 text-body-s text-[var(--danger)]" role="alert">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    )
  }
)
FileUpload.displayName = "FileUpload"

export interface FilePreviewItemProps {
  file: File
  onRemove?: () => void
  className?: string
}

const FilePreviewItem = React.forwardRef<HTMLDivElement, FilePreviewItemProps>(
  ({ file, onRemove, className }, ref) => {
    const sizeLabel =
      file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} م.ب` : `${Math.round(file.size / 1024)} ك.ب`

    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-2.5",
          className
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--bg-elevated)]">
          <FileIcon className="h-4 w-4 text-[var(--text-muted)]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-s font-medium text-primary">{file.name}</p>
          <p className="text-caption text-muted">{sizeLabel}</p>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`إزالة ${file.name}`}
            className="shrink-0 rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    )
  }
)
FilePreviewItem.displayName = "FilePreviewItem"

export { FileUpload, FilePreviewItem }
