import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { SseBridge } from './components/SseBridge';
import { ThemeApplier } from './components/ThemeApplier';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * In dev the handshake bootstrap arrives asynchronously (the metadesk-dev
 * Vite plugin fetches the portfile). Wait briefly for it so the first
 * queries already carry the token; in prod the server injects it inline
 * before this module runs, so this resolves immediately.
 */
function useBootstrapReady(): boolean {
  const [ready, setReady] = useState(() => window.__METADESK__ !== undefined);
  useEffect(() => {
    if (ready) return;
    const onBootstrap = () => setReady(true);
    window.addEventListener('metadesk:bootstrap', onBootstrap);
    const timeout = setTimeout(() => setReady(true), 1_500);
    return () => {
      window.removeEventListener('metadesk:bootstrap', onBootstrap);
      clearTimeout(timeout);
    };
  }, [ready]);
  return ready;
}

function Root() {
  const ready = useBootstrapReady();
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        Connecting to the MetaDesk server…
      </div>
    );
  }
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeApplier />
      <SseBridge />
      <App />
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
