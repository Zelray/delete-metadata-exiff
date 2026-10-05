import { useEffect, type ReactNode } from 'react';
import { ModeBanner } from './ModeBanner';
import { StatusStrip } from './StatusStrip';
import { CommandPreviewDrawer } from './CommandPreviewDrawer';
import { HelpOverlay } from './HelpOverlay';
import { useUiStore } from '../state/store';
import { navigate, useRoute, type Route } from '../lib/router';
import { pathBreadcrumb } from '../lib/format';
import { Input } from '../components/ui/controls';

interface NavItem {
  route: Route;
  label: string;
  hint: string;
  /** Shown with a "soon" marker until its leaf lands — the nav stays honest. */
  deferred?: boolean;
}

const NAV: NavItem[] = [
  { route: '/', label: 'Browse', hint: 'Pick a folder and scan it' },
  { route: '/console', label: 'Console', hint: 'Raw read commands, validator-gated' },
  {
    route: '/history',
    label: 'History',
    hint: 'Every change with its backup proof',
    deferred: true,
  },
  {
    route: '/settings',
    label: 'Settings',
    hint: 'Engine path, defaults, safety floors',
    deferred: true,
  },
];

/**
 * The three-zone frame (ux-spec): left rail for navigation, center for the
 * grid/detail work, one persistent bottom drawer for the Command Preview.
 * Every element has exactly one home so nothing ever moves.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const helpOpen = useUiStore((s) => s.helpOpen);
  const scanResult = useUiStore((s) => s.scanResult);

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

        {/* Always-visible Undo (arrives with the write journal) */}
        <button
          type="button"
          disabled
          title="Undo arrives with write mode — every change will be one click reversible."
          className="rounded-md px-2 py-1 text-xs text-muted-foreground/60 cursor-not-allowed"
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
                {item.deferred === true && (
                  <span className="text-[10px] uppercase tracking-wide opacity-50">soon</span>
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
      <StatusStrip />
      <HelpOverlay />
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
