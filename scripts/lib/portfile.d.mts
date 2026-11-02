/** Type surface for ui/vite.config.ts's import of the portfile reader. */

export interface Portfile {
  port: number;
  token: string;
  pid: number;
  startedAt?: string;
  engine?: string;
  url: string;
  [key: string]: unknown;
}

export interface PollPortfileOptions {
  timeoutMs: number;
  intervalMs?: number;
  abort?: (() => string | null) | null;
  accept?: ((candidate: Portfile) => boolean) | null;
}

export declare function readPortfile(filePath: string): Portfile | null;
export declare function pollPortfile(
  filePath: string,
  options: PollPortfileOptions,
): Promise<Portfile | null>;
