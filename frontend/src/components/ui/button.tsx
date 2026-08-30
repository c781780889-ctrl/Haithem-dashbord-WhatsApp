import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
  "transition-all duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-[var(--bg-app)] disabled:pointer-events-none disabled:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 select-none active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border border-primary-border shadow-xs hover:brightness-110 hover:shadow-[var(--shadow-glow)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs border border-destructive-border hover:brightness-110",
        outline:
          "border [border-color:var(--button-outline)] shadow-xs active:shadow-none hover:bg-[var(--bg-hover)]",
        secondary:
          "border bg-secondary text-secondary-foreground border-secondary-border hover:bg-[var(--bg-active)]",
        ghost:
          "border border-transparent hover:bg-[var(--bg-hover)]",
        link:
          "text-primary underline-offset-4 hover:underline",
        soft:
          "bg-[var(--brand-primary-light)] text-[var(--brand-primary)] border border-transparent hover:bg-[var(--brand-primary-glow)]",
      },
      size: {
        xs: "min-h-7 rounded-md px-2.5 text-xs gap-1.5",
        sm: "min-h-8 rounded-md px-3 text-xs",
        default: "min-h-9 px-4 py-2",
        lg: "min-h-10 rounded-md px-8",
        xl: "min-h-12 rounded-lg px-10 text-base",
        icon: "h-9 w-9",
        "icon-sm": "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && (
          <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        )}
        {children}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
