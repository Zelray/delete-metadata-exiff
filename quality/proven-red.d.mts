import type { TestRunner } from './test-runner.mjs';
export interface ClassifiedPaths { unitTests: string[]; e2eTests: string[]; testSupport: string[]; source: string[]; gateFiles: string[] }
export interface Skip { reason: string; warn: boolean }
export interface ProvenRedOptions {
  base: string;
  head?: string;
  repo: string;
  title?: string;
  dependencyRoot?: string;
  runTests?: TestRunner;
  log?: (line: string) => void;
}
export const SKIP_TYPES: string[];
export function classify(files: string[], deleted?: Set<string>): ClassifiedPaths;
export function skipReason(title: string | undefined, split: ClassifiedPaths): Skip | null;
export function proveRed(options: ProvenRedOptions): number;
