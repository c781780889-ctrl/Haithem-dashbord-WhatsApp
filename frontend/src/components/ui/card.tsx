import * as React from "react"

import { cn } from "@/lib/utils"
import { attachCardHover } from "@/lib/motion"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    variant?: "default" | "glass" | "glow"
    /** Opt-in GSAP hover lift (motion.csv preset #2). Off by default so
     *  existing dense tables/lists of cards aren't affected unintentionally. */
    hoverMotion?: boolean
  }
>(({ className, variant = "default", hoverMotion = false, ...props }, ref) => {
  const innerRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement)

  React.useEffect(() => {
    if (!hoverMotion || !innerRef.current) return
    return attachCardHover(innerRef.current)
  }, [hoverMotion])

  return (
    <div
      ref={innerRef}
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow card",
        variant === "glass" && "card-glass",
        variant === "glow" && "card-glow",
        className
      )}
      {...props}
    />
  )
})
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-heading-s leading-none tracking-tight", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-body-s text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
