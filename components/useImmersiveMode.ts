'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export function useImmersiveMode(
  shellRef: RefObject<HTMLDivElement | null>,
  entryButtonRef: RefObject<HTMLButtonElement | null>,
  microphoneButtonRef: RefObject<HTMLButtonElement | null>,
) {
  const [immersive, setImmersive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const mounted = useRef(false);
  const active = useRef(false);
  const nativeActive = useRef(false);
  const pending = useRef<{ element: HTMLDivElement } | null>(null);
  const leavingNative = useRef<Promise<void> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFrame = useRef<number | null>(null);
  const previousOverflow = useRef<{ value: string; priority: string } | null>(null);

  const clearScheduled = useCallback(() => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    hideTimer.current = null;
    focusFrame.current = null;
  }, []);

  const restoreOverflow = useCallback(() => {
    const previous = previousOverflow.current;
    if (previous) document.body.style.setProperty('overflow', previous.value, previous.priority);
    previousOverflow.current = null;
  }, []);

  const leaveNative = useCallback((element: HTMLDivElement | null) => {
    if (!element || document.fullscreenElement !== element || leavingNative.current) return;
    nativeActive.current = false;
    const transition = document.exitFullscreen();
    leavingNative.current = transition;
    void transition.catch(() => { /* The browser may already be leaving fullscreen. */ }).finally(() => {
      if (leavingNative.current === transition) leavingNative.current = null;
    });
  }, []);

  const revealControls = useCallback(() => {
    if (!active.current || !mounted.current) return;
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    setControlsVisible(true);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (mounted.current && active.current) setControlsVisible(false);
    }, 3_000);
  }, []);

  const exit = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    nativeActive.current = false;
    clearScheduled();
    restoreOverflow();
    leaveNative(shellRef.current);
    if (!mounted.current) return;
    setImmersive(false);
    setControlsVisible(false);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (mounted.current && !active.current) entryButtonRef.current?.focus({ preventScroll: true });
    });
  }, [clearScheduled, entryButtonRef, leaveNative, restoreOverflow, shellRef]);

  const focusMicrophone = useCallback(() => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (mounted.current && active.current && !shellRef.current?.querySelector('dialog[open]')) {
        microphoneButtonRef.current?.focus({ preventScroll: true });
      }
    });
  }, [microphoneButtonRef, shellRef]);
  const enter = useCallback(() => {
    const element = shellRef.current;
    if (!mounted.current || active.current || !element) return;
    clearScheduled();
    active.current = true;
    previousOverflow.current = {
      value: document.body.style.getPropertyValue('overflow'),
      priority: document.body.style.getPropertyPriority('overflow'),
    };
    document.body.style.setProperty('overflow', 'hidden');
    setImmersive(true);
    revealControls();
    focusMicrophone();


    // Invoke synchronously during the click, retaining the browser's user activation.
    // A rejected or unavailable native request leaves the CSS immersive mode active.
    if (!element.requestFullscreen || pending.current || leavingNative.current) return;
    const request = { element };
    pending.current = request;
    try {
      void element.requestFullscreen().then(() => {
        if (!mounted.current || !active.current) {
          leaveNative(element);
        } else if (!leavingNative.current) {
          // A newer explicit entry may adopt this still-pending native request.
          nativeActive.current = document.fullscreenElement === element;
          if (nativeActive.current) focusMicrophone();
        }
      }, () => {}).finally(() => {
        if (pending.current === request) pending.current = null;
      });
    } catch {
      pending.current = null;
    }
  }, [clearScheduled, focusMicrophone, leaveNative, revealControls, shellRef]);

  useEffect(() => {
    mounted.current = true;
    const element = shellRef.current;
    const onFullscreenChange = () => {
      if (document.fullscreenElement === element) {
        if (!active.current) {
          leaveNative(element);
        } else if (!leavingNative.current) {
          nativeActive.current = true;
        }
      } else if (nativeActive.current) {
        nativeActive.current = false;
        exit();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active.current) return;
      revealControls();
      // An open dialog keeps its own Escape behavior; native Escape is observed above.
      if (event.key === 'Escape' && !element?.querySelector('dialog[open]')
        && document.fullscreenElement !== element) {
        event.preventDefault();
        exit();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      mounted.current = false;
      active.current = false;
      nativeActive.current = false;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
      clearScheduled();
      restoreOverflow();
      leaveNative(element);
    };
  }, [clearScheduled, exit, leaveNative, restoreOverflow, revealControls, shellRef]);

  return { immersive, controlsVisible, enter, exit, revealControls };
}
