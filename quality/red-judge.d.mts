import type { RunResult } from './test-runner.mjs';
export interface Verdict { code: 0 | 1 | 2; lines: string[]; warnings: string[] }
export interface FailureKinds { assertions: number; missing: number; other: number; sample?: string }
export interface BaselineVerdict { code: 0 | 2; names: Set<string>; reason: string }
export function classifyFailures(messages: string[]): FailureKinds;
export function judgeBaseline(file: string, run: RunResult): BaselineVerdict;
export function judge(file: string, run: RunResult, oldNames?: Set<string>): Verdict;
