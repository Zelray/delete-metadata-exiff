import { useEffect, useState } from 'react';

/**
 * Tiny hash router. Deliberately dependency-free: MetaDesk has six routes and
 * no nested routing needs, so a ~40-line router keeps the approved-deps list
 * honest (BUILD-NOTES: TanStack Query + zustand, nothing heavyweight).
 *
 * Routes reserved for later leaves stay real routes — the panels are honest
 * stubs saying the feature arrives with write mode.
 */
export const ROUTES = ['/', '/browse', '/console', '/edit', '/batch', '/history', '/settings'] as const;

export type Route = (typeof ROUTES)[number];

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const path = raw.split('?')[0] ?? '/';
  const match = (ROUTES as readonly string[]).includes(path)
    ? (path as Route)
    : '/';
  return match;
}

export function navigate(route: Route): void {
  if (parseHash() === route) return;
  window.location.hash = `#${route}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
