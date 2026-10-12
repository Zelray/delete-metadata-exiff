export interface SourceFile {
  path: string;
  text: string;
  language: string;
}
export interface Finding {
  rule: string;
  path: string;
  line: number;
  evidence: string;
  identity?: string;
}
export interface VendorSnapshot {
  version: number;
  scope: string;
  fileCount: number;
  sha256: string;
}
export interface InstructionInputs {
  texts: Record<string, string>;
  paths: string[];
  files: SourceFile[];
  tests: SourceFile[];
  docs: { path: string; text: string }[];
  tracked: string[];
  changed: string[];
  vendorBaseline: VendorSnapshot;
  vendorActual: VendorSnapshot;
  commitExists: (hash: string) => boolean;
}
export interface InstructionStats {
  words: number;
  wordBudget: number;
  contracts: number;
  tokens: number;
  knowledgeFiles: number;
  commitHashes: number;
  docs: number;
  ruleReferences: number;
  sources: number;
  tests: number;
  parsedSources: number;
  reviewSources: number;
  vendorFiles: number;
  sourceScopes: Record<string, number>;
  testScopes: Record<string, number>;
  processFindings: number;
}
export interface InstructionResult {
  findings: Finding[];
  stats: InstructionStats;
  processFindings: Finding[];
}
export interface ControlResult {
  controls: number;
  results: { name: string; rule: string; findings: number }[];
  stats: InstructionStats;
}
export const WORD_BUDGET: number;
export const REQUIRED_INSTRUCTIONS: string[];
export const HELP_PAIR: string[];
export function foldFields(body: string): string[];
export function vendorSnapshot(root?: string, tracked?: string[]): VendorSnapshot;
export function loadInstructionInputs(root?: string, changed?: string[]): InstructionInputs;
export function inspectInstructions(input: InstructionInputs): InstructionResult;
export function runInstructionGate(options?: { root?: string; changedPaths?: string[] }): InstructionResult;
export function runInstructionControls(input?: InstructionInputs): ControlResult;
