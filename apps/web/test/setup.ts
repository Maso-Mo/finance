import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom ne fournit pas matchMedia : on pose un mock minimal et pilotable
// (les tests ajustent `window.__setSystemDark` pour simuler le thème OS).
let systemDark = false;
const listeners = new Set<(event: MediaQueryListEvent) => void>();

function createMediaQueryList(query: string): MediaQueryList {
  return {
    media: query,
    matches: systemDark && query.includes('(prefers-color-scheme: dark)'),
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    dispatchEvent: () => false,
  } as MediaQueryList;
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => createMediaQueryList(query);
}

// Permet aux tests de simuler un changement du thème système.
(window as unknown as { __setSystemDark: (dark: boolean) => void }).__setSystemDark = (
  dark: boolean,
) => {
  systemDark = dark;
  const event = { matches: dark } as MediaQueryListEvent;
  for (const listener of listeners) listener(event);
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});
