import { describe, expect, it } from 'vitest';
import { runInstructionControls } from '../../../quality/instruction.mjs';

describe('instruction negative controls', () => {
  it('rejects each injected violation and accepts safe aliases, comments and paired help', () => {
    const result = runInstructionControls();
    expect(result.controls).toBe(20);
    const failures = result.results.filter((control) => control.findings > 0).map((control) => control.name);
    expect(failures).toContain('missing contract path');
    expect(failures).toContain('comment-only symbol');
    expect(failures).toContain('moved declaration retains import and use');
    expect(failures).toContain('wrong paired file still exists');
    expect(failures).toContain('private address');
    expect(failures).toContain('empty production denominator');
    expect(failures).toContain('named write alias');
    expect(failures).toContain('namespace write alias');
    expect(failures).toContain('comment trap retains real transport');
    expect(failures).toContain('vendor changed');
    expect(failures).toContain('forbidden persistence alias');
    expect(result.results.find((control) => control.name === 'both help mirrors changed')?.findings).toBe(0);
    expect(result.results.find((control) => control.name === 'comments and strings ignored')?.findings).toBe(0);
    expect(result.results.find((control) => control.name === 'resolved safe process alias')?.findings).toBe(0);
    process.stdout.write(`instruction controls: ${JSON.stringify(result)}\n`);
  });
});
