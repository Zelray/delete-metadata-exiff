import { useEffect } from 'react';
import { AppShell } from './shell/AppShell';
import { Home } from './views/Home';
import { Browse } from './views/Browse';
import { ConsoleView } from './views/ConsoleView';
import { EditPanel } from './views/EditPanel';
import { BatchPanel } from './views/BatchPanel';
import { ResultsReport } from './views/ResultsReport';
import { HistoryView } from './views/HistoryView';
import { ScrubWizard } from './views/ScrubWizard';
import { SettingsView } from './views/SettingsView';
import { useRoute } from './lib/router';
import { setCommandPreviewSink } from './api/client';
import { useUiStore } from './state/store';

/**
 * Route table (leaf 1.1.5): every route is a real panel. The read shell keeps
 * its three-zone layout; the write surfaces — Edit, Batch, Results, History,
 * the AI-scrub wizard, and Settings — all route their writes through the same
 * mandatory Save Review gate. WriteStubs is gone; nothing here pretends.
 */
export default function App() {
  const route = useRoute();

  // Any API response carrying `commandPreview` feeds the persistent drawer —
  // the trust-and-teaching surface — without each view having to remember.
  // The client labels write commands so the drawer never calls one "read only".
  useEffect(() => {
    setCommandPreviewSink((argv, label, readOnly) => {
      useUiStore.getState().setNextCommand(argv, label, readOnly);
    });
    return () => setCommandPreviewSink(null);
  }, []);

  return (
    <AppShell>
      {route === '/' && <Home />}
      {route === '/browse' && <Browse />}
      {route === '/console' && <ConsoleView />}
      {route === '/edit' && <EditPanel />}
      {route === '/batch' && <BatchPanel />}
      {route === '/results' && <ResultsReport />}
      {route === '/history' && <HistoryView />}
      {route === '/settings' && <SettingsView />}
      {route === '/scrub' && <ScrubWizard />}
    </AppShell>
  );
}
