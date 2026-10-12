export interface SourceFile { path: string; text: string; language: string }
export interface Finding { path: string; rule: string; line: number; evidence: string; identity?: string }
export interface Snapshot { version: number; counts: Record<string, number>; findings: Record<string, number>; lengths: Record<string, number> }
export interface CheckResult { lines: string[]; code: number }
export const baselinePath: string;
export const SLACK: number;
export const MAX_CODE_LINES: number;
export const counters: Record<string, () => number>;
export function currentCounts(config?: Record<string, () => unknown>): Record<string, number>;
export function check(counts: Record<string, number>, baseline: Record<string, number>, slack?: number): CheckResult;
export function planUpdate(counts: Record<string, number>, baseline: Record<string, number>): { refusals: string[]; next: Record<string, number> };
export function findingKey(finding: Finding): string;
export function snapshotFrom(findings: Finding[], lengths: Record<string, number>, rules: string[]): Snapshot;
export function checkSnapshot(snapshot: Snapshot, baseline: Snapshot): CheckResult;
export function planSnapshotUpdate(snapshot: Snapshot, baseline: Snapshot): { refusals: string[]; next: Snapshot };
export function measure(options?: { fixtureRoot?: string }): Promise<Snapshot & { diagnostics: Finding[]; denominators: Record<string, number> }>;
export function run(argv: string[], output?: Pick<Console, 'log' | 'error'>): Promise<number>;
export function codeLineCount(file: SourceFile): number;
export function lintFindings(files: SourceFile[], options?: { virtual?: boolean }): Promise<{ findings: Finding[]; rules: string[]; files: number }>;
export function testQualityFindings(tests: SourceFile[], productionFiles: SourceFile[]): Finding[];
export function parseSource(file: SourceFile): import('typescript').SourceFile;
export function normalizedNode(node: import('typescript').Node, source: import('typescript').SourceFile): string;
