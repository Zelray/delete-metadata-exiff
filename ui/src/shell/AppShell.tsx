import { useEffect, type ReactNode } from 'react';
import { ModeBanner } from './ModeBanner';
import { StatusStrip } from './StatusStrip';
import { CommandPreviewDrawer } from './CommandPreviewDrawer';
import { HelpOverlay } from './HelpOverlay';
import { useUiStore } from '../state/store';
import { RUNNER_ROUTES, navigate, useRoute, type Route } from '../lib/router';
import { pathBreadcrumb } from '../lib/format';
import { Input } from '../components/ui/controls';
import { Button } from '../components/ui/button';
import { WriteRunModal, clearWriteCompletion } from '../write/useWriteRun';

interface NavItem {
  route: Route;
  label: string;
  hint: string;
}

const NAV: NavItem[] = [
  { route: '/', label: 'Browse', hint: 'Pick a folder and scan it' },
  { route: '/edit', label: 'Edit', hint: 'Change fields on the selection' },
  { route: '/batch', label: 'Batch apply', hint: 'One set of edits, many files' },
  { route: '/scrub', label: 'AI scrub', hint: 'Detect and remove AI-generation metadata' },
  { route: '/console', label: 'Console', hint: 'Raw read commands, validator-gated' },
  { route: '/history', label: 'History', hint: 'Every change with its backup proof' },
  { route: '/settings', label: 'Settings', hint: 'Engine, defaults, safety floors' },
];

/**
 * The three-zone frame (ux-spec): left rail for navigation, center for the
 * grid/detail work, one persistent bottom drawer for the Command Preview.
 * Every element has exactly one home so nothing ever moves. While writing is
 * unlocked the whole frame gains an amber border — the danger state reads
 * from across the room.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const helpOpen = useUiStore((s) => s.helpOpen);
  const scanResult = useUiStore((s) => s.scanResult);
  const writeUnlocked = useUiStore((s) => s.writeUnlocked);

  // Global keyboard: F1 opens plain-English help for the focused panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F1') {
        event.preventDefault();
        setHelpOpen(!helpOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen, setHelpOpen]);

  const crumbs = pathBreadcrumb(scanResult?.folder);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Amber frame while writes are unlocked — visible from across the room */}
      {writeUnlocked && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-40 border-2 border-warning/80"
        />
      )}

      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-3">
        <div className="flex items-baseline gap-2 pr-2">
          <span className="text-sm font-semibold tracking-tight">MetaDesk</span>
          <span className="hidden text-[10px] uppercase tracking-widest text-muted-foreground lg:inline">
            ExifTool workbench
          </span>
        </div>

        {/* Folder breadcrumb */}
        <nav
          aria-label="Folder"
          className="hidden min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground lg:flex"
        >
          {crumbs.length > 0 ? (
            crumbs.map((crumb, index) => (
              <span key={`${crumb.value}:${index}`} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden="true">›</span>}
                <span className="max-w-44 truncate" title={crumb.value}>
                  {crumb.label}
                </span>
              </span>
            ))
          ) : (
            <span className="italic opacity-60">No folder open</span>
          )}
        </nav>

        {/* Global file search (filters the grid's filenames) */}
        <TopBarSearch />

        {/* Always-visible Undo — one click to the journal-backed History */}
        <button
          type="button"
          onClick={() => navigate('/history')}
          title="Undo the last change — every write is journal-backed and reversible."
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Undo
        </button>

        <ModeBanner />
      </header>

      {/* Three-zone frame */}
      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <nav
          aria-label="Tools"
          className="flex w-44 shrink-0 flex-col gap-1 border-r border-border bg-card p-2"
        >
          {NAV.map((item) => {
            const active = route === item.route || (item.route === '/' && route === '/browse');
            return (
              <button
                key={item.route}
                type="button"
                title={item.hint}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(item.route)}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                  active
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <span>{item.label}</span>
                {(item.route === '/edit' || item.route === '/batch') && (
                  <span className="text-[10px] uppercase tracking-wide opacity-50">
                    {item.route === '/edit' ? 'sel' : 'many'}
                  </span>
                )}
              </button>
            );
          })}
          <div className="mt-auto px-3 pb-1 text-[10px] leading-4 text-muted-foreground/60">
            F1 — plain-English help for the focused panel
          </div>
        </nav>

        {/* Center work zone */}
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>

      <CommandPreviewDrawer />
      <WriteRunLatch />
      <StatusStrip />
      {/* The gate follows the user (arch-v11 leaf 1.5): on the four NON-runner
          routes no view mounts the Save Review modal, so the shell hosts the
          same WriteRunModal here. The host stays BEFORE HelpOverlay in the
          tree on purpose — help is z-50 like the gate and renders after it, so
          F1 mid-run still paints help OVER the gate (pre-existing stacking,
          preserved; no new z-tiers). */}
      <WriteRunModalHost />
      <HelpOverlay />
    </div>
  );
}

/**
 * The shell's fallback mount for the ONE Save Review modal. The route
 * predicate is the router's RUNNER_ROUTES — never a second hand-written list —
 * so the partition is mutually exclusive by route: exactly zero-or-one gate
 * dialog on every route (pinned by the session test).
 */
function WriteRunModalHost() {
  const route = useRoute();
  if ((RUNNER_ROUTES as readonly string[]).includes(route)) return null;
  return <WriteRunModal />;
}

/**
 * The honest completion latch (declared completion rule): when a write
 * finishes while the user is AWAY from its origin route, the shell says so and
 * offers the report — no yank. A failed run never claims success here. Hidden
 * while a gate dialog is up (the busy modal is the top surface) and cleared by
 * the View report click, or by any new review/run.
 */
function WriteRunLatch() {
  const completion = useUiStore((s) => s.writeRun.completion);
  const busy = useUiStore((s) => s.writeRun.busy);
  const gateOpen = useUiStore((s) => s.writeRun.groups !== null);
  if (completion === null || busy || gateOpen) return null;
  return (
    <div className="flex items-center gap-3 border-t border-border bg-card px-3 py-2 text-xs" role="status">
      {completion === 'done' ? (
        <>
          <span>Write finished — the Results report is ready.</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              clearWriteCompletion();
              navigate('/results');
            }}
          >
            View report
          </Button>
        </>
      ) : (
        <span>The write ran into a problem — check History for what actually happened.</span>
      )}
    </div>
  );
}

/** Global filename search wired to the grid's filter. */
function TopBarSearch() {
  const scanResult = useUiStore((s) => s.scanResult);
  const filter = useUiStore((s) => s.searchText);
  const setSearch = useUiStore((s) => s.setSearchText);

  return (
    <div className="w-56 shrink-0">
      <Input
        type="search"
        placeholder={scanResult !== null ? 'Search files…' : 'Search (open a folder first)'}
        disabled={scanResult === null}
        value={filter}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Search files by name"
      />
    </div>
  );
}
