export interface MutationTarget { readonly id: string; readonly file: string; readonly from: string; readonly to: string; readonly test: string; readonly testName: string }
export const MUTATIONS: readonly MutationTarget[];
export function applyMutation(source: string, target: MutationTarget): string;
