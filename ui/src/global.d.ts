/** Browser globals provided by the MetaDesk server/UI handshake. */
export {};

declare global {
  interface Window {
    /**
     * Injected by the Fastify server (prod) or the metadesk-dev-handshake
     * Vite plugin (dev). See BUILD-NOTES "Server/UI handshake".
     */
    __METADESK__?: {
      token: string;
      version: string;
      readOnlyDefault: boolean;
    };
  }
}

/** Vite's `?raw` import (used by tests to assert on module source text). */
declare module '*?raw' {
  const source: string;
  export default source;
}
