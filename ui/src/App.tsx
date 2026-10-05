import { useEffect } from 'react';
import { AppShell } from './shell/AppShell';
import { Home } from './views/Home';
import { Browse } from './views/Browse';
import { ConsoleView } from './views/ConsoleView';
import { EditStub, BatchStub, HistoryStub, SettingsStub } from './views/WriteStubs';
import { useRoute } from './lib/router';
import { setCommandPreviewSink } from './api/client';
import { useUiStore } from './state/store';

/**
 * Route table. Read surfaces are live; the write-side routes exist and say
 * honestly that they arrive with write mode (nav never lies).
 *
 * NOTE FOR LEAF 1.1.5 (write surfaces): App.tsx ownership transfers here with
 * the wave-4 handoff (PLAN.md dispatch table). The Edit/Batch/Save Review
 * views replace the stubs below; keep the three-zone shell.
 */
export default function App() {
  const route = useRoute();

  // Any API response carrying `commandPreview` feeds the persistent drawer —
  // the trust-and-teaching surface — without each view having to remember.
  useEffect(() => {
    setCommandPreviewSink((argv, label) => {
      useUiStore.getState().setNextCommand(argv, label, true);
    });
    return () => setCommandPreviewSink(null);
  }, []);

  return (
    <AppShell>
      {route === '/' && <Home />}
      {route === '/browse' && <Browse />}
      {route === '/console' && <ConsoleView />}
      {route === '/edit' && <EditStub />}
      {route === '/batch' && <BatchStub />}
      {route === '/history' && <HistoryStub />}
      {route === '/settings' && <SettingsStub />}
    </AppShell>
  );
}
