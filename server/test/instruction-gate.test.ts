import { describe, expect, it } from 'vitest';
import { runInstructionGate, WORD_BUDGET } from '../../quality/instruction.mjs';

// The helper derives the app root from its ESM file URL, independent of runner cwd.
describe('repository instruction contracts', () => {
  it('preserves templates, references, privacy, ownership and clean bypass clauses', () => {
    const result = runInstructionGate();
    expect(result.findings, JSON.stringify(result.findings, null, 2)).toEqual([]);
    expect(result.stats.contracts).toBe(5);
    expect(result.stats.tokens).toBeGreaterThan(30);
    expect(result.stats.words).toBeLessThanOrEqual(WORD_BUDGET);
    expect(result.stats.parsedSources).toBeGreaterThan(0);
    expect(result.stats.reviewSources).toBeGreaterThan(0);
    expect(result.stats.knowledgeFiles).toBeGreaterThanOrEqual(7);
    expect(result.stats.commitHashes).toBeGreaterThan(0);
    expect(result.stats.docs).toBeGreaterThan(0);
    expect(result.stats.vendorFiles).toBeGreaterThan(0);
    for (const [scope, count] of Object.entries(result.stats.sourceScopes)) expect(count, scope).toBeGreaterThan(0);
    for (const [scope, count] of Object.entries(result.stats.testScopes)) expect(count, scope).toBeGreaterThan(0);
    process.stdout.write(`instruction measurements: ${JSON.stringify(result.stats)}\n`);
  });
});
