import type { MutationTarget } from './mutations.mjs';
import type { RunResult, TestRunner } from './test-runner.mjs';
export interface MutationVerdict { code: 0 | 1 | 2; reason: string }
export interface MutationOptions {
  repo: string;
  ref?: string;
  dependencyRoot?: string;
  targets?: readonly MutationTarget[];
  runTests?: TestRunner;
  log?: (line: string) => void;
}
export function judgeMutation(target: MutationTarget, clean: RunResult, mutant: RunResult): MutationVerdict;
export function mutationSmoke(options: MutationOptions): number;
