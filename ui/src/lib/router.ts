import { useEffect, useState } from 'react';

/**
 * Tiny hash router. Deliberately dependency-free: MetaDesk has six routes and
 * no nested routing needs, so a ~40-line router keeps the approved-deps list
 * honest (BUILD-NOTES: TanStack Query + zustand, nothing heavyweight).
 *
 * Every route is a real panel in leaf 1.1.5 (read + write surfaces).
 */
export const ROUTES = [
  '/',
  '/browse',
  '/console',
  '/edit',
  '/batch',
  '/results',
  '/history',
  '/settings',
  '/scrub',
] as const;

export type Route = (typeof ROUTES)[number];

/**
 * The five routes whose views mount the write runner — and with it the Save
 * Review modal. Derived FROM ROUTES (typed as Route, so a rename or a typo is
 * a compile error, never a silently un-hosted gate): on these routes the
 * view's own mount renders the modal; on every OTHER route the shell's
 * WriteRunModalHost renders the same modal, so the gate follows the user
 * (arch-v11 leaf 1.5) without a second hand-written route list.
 */
const RUNNER_ROUTE_SET: ReadonlySet<Route> = new Set<Route>([
  '/edit',
  '/batch',
  '/results',
  '/history',
  '/scrub',
]);
export const RUNNER_ROUTES: readonly Route[] = ROUTES.filter((route) => RUNNER_ROUTE_SET.has(route));

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
