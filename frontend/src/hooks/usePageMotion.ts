import { useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { registerMotionPlugins, pageEnter, staggerChildrenIn } from '@/lib/motion';

/**
 * usePageMotion — applies the Page Transition + Stagger List motion presets
 * (motion.csv #5, #10) to a page's root container on every route change.
 *
 * Mount this ONCE at the layout level (AppLayout's <main> wrapper) rather
 * than per-view, so all 18 views get consistent motion without per-file edits
 * and without risking breaking any view's internal state/logic.
 */
export function usePageMotion<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const location = useLocation();

  useLayoutEffect(() => {
    registerMotionPlugins();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Page-level fade/slide-in (Preset #10/#11)
    pageEnter(el);
    // Stagger the direct content blocks inside the page (Preset #5)
    // Runs after pageEnter's fromTo is queued; GSAP tweens on the same
    // element/children compose fine since they touch transform/opacity only.
    const raf = requestAnimationFrame(() => {
      staggerChildrenIn(el);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return ref;
}
