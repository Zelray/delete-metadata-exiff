/**
 * AI-scrub service against the REAL engine: build a synthetic SD-style PNG
 * (the same chunk names A1111/NovelAI/ComfyUI write, applied with exiftool
 * itself), detect the family, wipe through the destructive gates, and prove
 * the removal with an independent exiftool read. Also proves the honesty
 * flags: alpha-channel risk, non-removable chunks, and the RAW block.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { SCRUB_CONFIRMATION_PHRASE, ScrubService } from '../../src/services/scrub.js';
import { WritePipelineError } from '../../src/services/writePipeline.js';
import { makePipeline, makeWriteFixture, readTagsOnce, writeSdMetadata, type PipelineHarness, type WriteFixture } from './helpers.js';
import { PNG_1X1 } from '../helpers.js';

/**
 * Build a ComfyUI-style PNG by inserting real tEXt chunks (keyword\0text)
 * before IEND — exactly the container ComfyUI writes with PIL PngInfo. The
 * `prompt`/`workflow` keywords are NOT in exiftool's writable PNG table, so
 * these chunks are detectable but not deletable by name.
 */
function pngWithTextChunks(chunks: Array<{ keyword: string; text: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const { keyword, text } of chunks) {
    const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const type = Buffer.from('tEXt', 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    parts.push(len, type, data, crc);
  }
  const iendIndex = PNG_1X1.indexOf(Buffer.from('IEND', 'latin1')) - 4; // before the length field
  return Buffer.concat([PNG_1X1.subarray(0, iendIndex), ...parts, PNG_1X1.subarray(iendIndex)]);
}

let fixture: WriteFixture;
let harness: PipelineHarness;
let scrub: ScrubService;

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-scrub-');
  harness = await makePipeline(fixture);
  scrub = new ScrubService({
    engine: harness.session,
    pipeline: harness.pipeline,
    dataDir: fixture.dataDir,
  });
}, 60_000);

afterAll(async () => {
  await harness?.shutdown();
  await fixture?.cleanup();
});

describe('detect', () => {
  it('finds the SD family on a synthetic generation PNG and flags hidden-alpha risk', async () => {
    const png = await fixture.put('sd-image.png');
    await writeSdMetadata(png);

    const report = await scrub.detect([png]);
    expect(report.scope).toBe('ai-generation-metadata');
    expect(report.requiresTypedConfirmation).toBe(true);
    expect(report.confirmationPhrase).toBe(SCRUB_CONFIRMATION_PHRASE);

    const finding = report.files[0];
    expect(finding?.softwareMatches).toContain('automatic1111'); // EXIF:Software value
    expect(finding?.softwareMatches).toContain('novelai'); // PNG:Software value
    expect(finding?.possibleHiddenAlphaData).toBe(true); // RGBA PNG
    expect(finding?.hiddenAlphaNote).toMatch(/alpha channel/i);

    const foundTags = finding?.tags.map((t) => t.tag.toLowerCase()) ?? [];
    expect(foundTags).toContain('png:parameters');
    expect(foundTags).toContain('png:comment');
    expect(foundTags).toContain('png:software');
    expect(foundTags).toContain('ifd0:software'); // EXIF:Software under -G1
    expect(foundTags).toContain('exififd:usercomment');

    // Every found tag in this fixture is removable by name.
    expect(report.affectedTags.length).toBeGreaterThanOrEqual(5);
    // Values are summarized, not full prompts, unless requested.
    expect(finding?.tags[0]?.value.length).toBeLessThanOrEqual(161);

    const full = await scrub.detect([png], { includeFullValues: true });
    expect(full.files[0]?.tags.some((t) => t.value.includes('Steps: 20'))).toBe(true);
  });

  it('reports ComfyUI prompt/workflow chunks as detected-but-not-removable (honesty, not a lie)', async () => {
    const comfy = pngWithTextChunks([
      { keyword: 'prompt', text: '{"1": {"class_type": "CheckpointLoaderSimple"}}' },
      { keyword: 'workflow', text: '{"nodes": [], "links": []}' },
    ]);
    const png = await fixture.put('comfy-image.png', comfy);

    // exiftool genuinely reads the dynamic chunks back.
    const before = await readTagsOnce(png, []);
    expect(before['PNG:Prompt']).toBeDefined();
    expect(before['PNG:Workflow']).toBeDefined();

    const report = await scrub.detect([png]);
    const finding = report.files[0];
    const prompt = finding?.tags.find((t) => t.tag.toLowerCase() === 'png:prompt');
    const workflow = finding?.tags.find((t) => t.tag.toLowerCase() === 'png:workflow');
    expect(prompt?.removable).toBe(false);
    expect(prompt?.note).toMatch(/cannot delete this chunk by name/i);
    expect(workflow?.removable).toBe(false);

    // A file whose AI chunks are ALL non-removable is refused with a clear
    // reason instead of pretending to clean it.
    await expect(scrub.wipe([png], SCRUB_CONFIRMATION_PHRASE)).rejects.toMatchObject({
      code: 'validation',
    });
    const after = await readTagsOnce(png, ['PNG:Prompt', 'PNG:Workflow']);
    expect(after['PNG:Prompt']).toBeDefined(); // untouched, as reported
    expect(after['PNG:Workflow']).toBeDefined();
  });

  it('reports clean files as clean', async () => {
    const clean = await fixture.put('scrub-clean.png');
    const report = await scrub.detect([clean]);
    expect(report.cleanFilePaths).toContain(clean);
    expect(report.files[0]?.tags).toEqual([]);
    expect(report.affectedTags).toHaveLength(0);
  });

  it('blocks RAW files from the scrub entirely (requirement 15)', async () => {
    const raw = await fixture.put('raw-shot.nef');
    const report = await scrub.detect([raw]);
    expect(report.blockedFilePaths).toEqual([
      { filePath: raw, reason: expect.stringMatching(/RAW files are limited/) },
    ]);
    expect(report.files).toHaveLength(0);
  });
});

describe('wipe', () => {
  it('refuses to run without the exact typed confirmation phrase', async () => {
    const png = await fixture.put('wipe-gated.png');
    await writeSdMetadata(png);
    await expect(scrub.wipe([png], '')).rejects.toMatchObject({
      code: 'destructive_confirmation_required',
    });
    await expect(scrub.wipe([png], 'remove ai metadata')).rejects.toMatchObject({
      code: 'destructive_confirmation_required',
    });
    await expect(scrub.wipe([png], 'delete everything')).rejects.toBeInstanceOf(WritePipelineError);
  });

  it('wipes the SD family through the pipeline and proves removal with an independent read', async () => {
    const png = await fixture.put('wipe-me.png');
    await writeSdMetadata(png);

    const wipe = await scrub.wipe([png], SCRUB_CONFIRMATION_PHRASE);
    expect(wipe.result.outcome.files[0]?.status).toBe('updated');
    expect(wipe.result.outcome.files[0]?.verified).toBe(true);
    expect(wipe.result.outcome.files[0]?.backup).toBeDefined(); // default backup mode

    // Mandatory pre-write export beside the journal, carrying FULL values.
    const { readFile } = await import('node:fs/promises');
    const exported = JSON.parse(await readFile(wipe.exportedValuesPath, 'utf8')) as {
      values: Array<{ tag: string; value: string }>;
    };
    expect(exported.values.length).toBeGreaterThanOrEqual(5);
    expect(exported.values.some((v) => v.value.includes('Steps: 20'))).toBe(true);

    // Independent verification: a fresh exiftool process sees the tags gone.
    const after = await readTagsOnce(png, [
      'PNG:Parameters',
      'PNG:Comment',
      'PNG:Software',
      'EXIF:UserComment',
      'EXIF:Software',
      'XMP-dc:Description',
    ]);
    expect(after['PNG:Parameters']).toBeUndefined();
    expect(after['PNG:Comment']).toBeUndefined();
    expect(after['PNG:Software']).toBeUndefined();
    expect(after['IFD0:Software']).toBeUndefined();
    expect(after['ExifIFD:UserComment']).toBeUndefined();
    expect(after['XMP-dc:Description']).toBeUndefined();

    // The honesty list still names the alpha-channel risk it cannot remove.
    expect(
      wipe.notRemoved.some((n) => /alpha channel|pixel data/i.test(n.tag + n.reason)),
    ).toBe(true);
  });

  it('refuses to wipe when nothing removable was found', async () => {
    const clean = await fixture.put('nothing-to-wipe.png');
    await expect(scrub.wipe([clean], SCRUB_CONFIRMATION_PHRASE)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('keeps RAW files out of the wipe', async () => {
    const raw = await fixture.put('raw-scrub.nef');
    await expect(scrub.wipe([raw], SCRUB_CONFIRMATION_PHRASE)).rejects.toMatchObject({
      code: 'validation',
    });
  });
});
