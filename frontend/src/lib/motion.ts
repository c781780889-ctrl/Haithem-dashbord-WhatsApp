/**
 * Motion Layer — Enterprise Design System
 * ----------------------------------------
 * Centralized GSAP presets sourced from the ui-ux-pro-max skill's motion.csv
 * (Hover Micro-interaction, Scroll Reveal, Stagger List, Page Transition tiers).
 *
 * This is intentionally the LAST layer applied on top of an already-stable
 * HTML/component structure — it never changes layout, only transform/opacity,
 * so it stays on the compositor thread and never fights Tailwind/RTL layout.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let registered = false;
export function registerMotionPlugins() {
  if (registered) return;
  gsap.registerPlugin(ScrollTrigger);
  registered = true;
}

/** Respect prefers-reduced-motion across the entire motion layer.
 *  Cached + live-updated via a change listener so a user flipping the OS
 *  setting mid-session is honored immediately without a page reload. */
let _reducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (e: MediaQueryListEvent) => {
    _reducedMotion = e.matches;
    if (e.matches) {
      // Immediately stop any in-flight/looping tweens (e.g. skeleton shimmer,
      // magnetic hover) so the change takes effect without waiting for the
      // next interaction.
      gsap.globalTimeline.getChildren().forEach((tween) => tween.progress(1));
    }
  };
  mq.addEventListener?.('change', handler);
}

export const prefersReducedMotion = () => _reducedMotion;

/* ------------------------------------------------------------------ */
/* Preset #10/#11 — Page Transition (Subtle/Standard, route change)    */
/* ------------------------------------------------------------------ */
export function pageEnter(el: Element | null) {
  if (!el) return;
  if (prefersReducedMotion()) {
    gsap.set(el, { opacity: 1, y: 0 });
    return;
  }
  gsap.fromTo(
    el,
    { opacity: 0, y: 12 },
    { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' }
  );
}

/* ------------------------------------------------------------------ */
/* Preset #5 — Scroll Reveal / Stagger (Standard, viewport enter)      */
/* Used for the direct children of a page's root container.           */
/* ------------------------------------------------------------------ */
export function staggerChildrenIn(container: Element | null, selector = ':scope > *') {
  if (!container) return;
  const items = container.querySelectorAll(selector);
  if (!items.length) return;
  if (prefersReducedMotion()) {
    gsap.set(items, { opacity: 1, y: 0 });
    return;
  }
  gsap.fromTo(
    items,
    { opacity: 0, y: 16 },
    {
      opacity: 1,
      y: 0,
      duration: 0.4,
      stagger: Math.min(0.06, 0.5 / items.length),
      ease: 'power2.out',
      clearProps: 'transform,opacity',
    }
  );
}

/* ------------------------------------------------------------------ */
/* Preset #2 — Hover Micro-interaction (Standard, card lift)           */
/* ------------------------------------------------------------------ */
export function attachCardHover(el: HTMLElement) {
  if (prefersReducedMotion()) return () => {};
  const enter = () =>
    gsap.to(el, {
      y: -4,
      scale: 1.02,
      boxShadow: '0 12px 24px rgba(0,0,0,0.12)',
      duration: 0.25,
      ease: 'power2.out',
    });
  const leave = () =>
    gsap.to(el, {
      y: 0,
      scale: 1,
      boxShadow: '0 0 0 rgba(0,0,0,0)',
      duration: 0.25,
      ease: 'power2.out',
    });
  el.addEventListener('mouseenter', enter);
  el.addEventListener('mouseleave', leave);
  return () => {
    el.removeEventListener('mouseenter', enter);
    el.removeEventListener('mouseleave', leave);
  };
}

/* ------------------------------------------------------------------ */
/* Preset #1 — Hover Micro-interaction (Subtle, button feedback)       */
/* ------------------------------------------------------------------ */
export function attachButtonPress(el: HTMLElement) {
  if (prefersReducedMotion()) return () => {};
  const down = () => gsap.to(el, { scale: 0.97, duration: 0.12, ease: 'power1.out' });
  const up = () => gsap.to(el, { scale: 1, duration: 0.15, ease: 'power1.out' });
  el.addEventListener('mousedown', down);
  el.addEventListener('mouseup', up);
  el.addEventListener('mouseleave', up);
  return () => {
    el.removeEventListener('mousedown', down);
    el.removeEventListener('mouseup', up);
    el.removeEventListener('mouseleave', up);
  };
}

/* ------------------------------------------------------------------ */
/* Preset #15 — Loading / Skeleton shimmer loop                       */
/* ------------------------------------------------------------------ */
export function attachSkeletonShimmer(el: Element | null) {
  if (!el || prefersReducedMotion()) return null;
  const tween = gsap.to(el, {
    backgroundPosition: '200% 0',
    duration: 1.4,
    ease: 'sine.inOut',
    repeat: -1,
  });
  return tween;
}

export { gsap, ScrollTrigger };
