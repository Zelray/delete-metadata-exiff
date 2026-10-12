export interface Scratch { root: string; commit: string; cleanup(): void }
export interface ScratchOptions { repo: string; ref: string; dependencyRoot?: string; log?: (line: string) => void }
export interface DependencyLinks { links: number; workspaces: string[]; cleanup(): void }
export interface ControlRepo { repo: string; write(file: string, content: string): void; commit(subject: string): string; cleanup(): void }
export function git(repo: string, args: string[], binary?: false): string;
export function git(repo: string, args: string[], binary: true): Buffer;
export function resolveCommit(repo: string, ref: string): string;
export function safePath(root: string, relative: string): string;
export function changedPaths(repo: string, base: string, head: string): { files: string[]; deleted: Set<string> };
export function linkDependencies(root: string, dependencyRoot: string): DependencyLinks;
export function createScratch(options: ScratchOptions): Scratch;
export function copyFromCommit(repo: string, ref: string, root: string, file: string): void;
export function createControlRepo(): ControlRepo;
