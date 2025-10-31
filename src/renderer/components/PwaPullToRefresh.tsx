/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect } from 'react';
import usePwaMode from '@/renderer/hooks/usePwaMode';

/**
 * Lightweight pull-to-refresh for iOS PWA standalone mode.
 * - Triggers reload when user pulls down from top beyond a threshold.
 * - No persistent UI; avoids an always-visible button.
 */
const PwaPullToRefresh: React.FC = () => {
  const isPwa = usePwaMode();

  useEffect(() => {
    if (!isPwa) return;

    const container = (document.querySelector('.layout-content') as HTMLElement) || (document.scrollingElement as HTMLElement) || document.documentElement;

    let startY = 0;
    let deltaY = 0;
    let tracking = false;
    const threshold = 70; // px

    const isTextInput = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (isTextInput(e.target)) return; // avoid interfering with text selection/editing
      const atTop = (container.scrollTop || window.scrollY || 0) <= 0;
      if (!atTop) return;
      startY = e.touches[0].clientY;
      deltaY = 0;
      tracking = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const currentY = e.touches[0].clientY;
      deltaY = currentY - startY;
      if (deltaY <= 0) return; // only consider pull down
      // Do not prevent default to preserve natural bounce; we only act on release
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (deltaY >= threshold) {
        window.location.reload();
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart, false);
      container.removeEventListener('touchmove', onTouchMove, false);
      container.removeEventListener('touchend', onTouchEnd, false);
    };
  }, [isPwa]);

  return null;
};

export default PwaPullToRefresh;
