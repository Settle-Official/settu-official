"use client";

import { useEffect } from "react";
import Lenis from "lenis";

/**
 * Mounted once at the root layout so every route (landing page, dashboard,
 * auth pages) gets the same smooth-scroll feel. Lenis wraps the browser's
 * own scroll rather than replacing it — position:sticky, anchor links, and
 * anything reading window.scrollY/IntersectionObserver (the landing page's
 * scroll-reveal sections, the trust-section connector curve) keep working
 * unchanged, just smoothed. Reduced-motion users get native 1:1 scrolling
 * automatically (Lenis's own `respectReducedMotion` default).
 */
export function SmoothScroll() {
  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: true,
      anchors: true,
      // Lenis walks up from the wheel target and, unless something opts
      // out, smooth-scrolls the page. The Stellar Wallets Kit picker is a
      // fixed overlay with its own scrolling list that we don't render (so
      // it can't carry data-lenis-prevent); without this, wheeling over the
      // wallet list scrolls the page behind it instead.
      prevent: (node) => node.classList?.contains("stellar-wallets-kit") ?? false,
    });

    // The kit mounts/unmounts its picker directly under <body>. While it's
    // open, freeze page scrolling entirely: `prevent` alone only stops
    // Lenis, and the browser's scroll chaining then carries a wheel that the
    // wallet list can't consume through to the page. Stopped, Lenis eats
    // wheel events everywhere except over the picker (prevent runs first).
    const syncPicker = () => {
      if (document.querySelector("section.stellar-wallets-kit")) lenis.stop();
      else lenis.start();
    };
    const observer = new MutationObserver(syncPicker);
    observer.observe(document.body, { childList: true });
    syncPicker();

    return () => {
      observer.disconnect();
      lenis.destroy();
    };
  }, []);

  return null;
}
