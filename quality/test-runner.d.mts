export type TestStatus = 'passed' | 'failed' | 'pending' | 'skipped' | 'todo' | 'disabled';
export interface TestResult { name: string; status: TestStatus; messages: string[] }
export interface FileResult { file: string; status: 'passed' | 'failed'; message: string; tests: TestResult[] }
export interface RunResult {
  code: number | null;
  signal?: string | null;
  reportAvailable: boolean;
  fileResults: FileResult[];
  report?: string;
  error?: string;
}
export interface RunnerOptions {
  timeoutMs?: number;
  requireEngine?: boolean;
  testName?: string;
  log?: (line: string) => void;
}
export type TestRunner = (root: string, file: string, options?: RunnerOptions) => RunResult;
export const RUN_TIMEOUT_MS: number;
export function readFileResults(report: string, root?: string): FileResult[];
export function resultFor(results: FileResult[], file: string): FileResult | undefined;
export function validateRun(run: RunResult, file: string): string | null;
export function runVitest(root: string, file: string, options?: RunnerOptions): RunResult;
export function isMain(url: string): boolean;
export default class ProvenanceReporter {
  hooks: Map<string, number>;
  onHookStart(context: { name: string; entity: { id: string } }): void;
  onHookEnd(context: { name: string; entity: { id: string } }): void;
  onTestRunEnd(modules: unknown[], unhandledErrors: unknown[], reason: string): void;
}
