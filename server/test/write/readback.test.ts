/**
 * The readback module's three signals (values / readPaths / readErrors),
 * driven by a hand-rolled session fake: the session IS the system boundary
 * here (the persistent exiftool driver resolves in-band errors and empty
 * reads without ever throwing), so a plain object with a canned run() is the
 * sanctioned fake — no module mocks. These classifications are what let the
 * write pipeline tell "the tag is genuinely absent" from "the read never
 * reached the file" (issue #3, the vacuous delete verify).
 */
import { describe, expect, it } from 'vitest';
import type { EngineRequestResult, ExifDiagnostic } from '@metadesk/shared';
import type { ExifToolSession } from '../../src/engine/exiftoolSession.js';
import { readTagValues } from '../../src/services/readback.js';

/** Records what the module asked the engine to run. */
interface RecordedRun {
  args: readonly string[];
  opts: { json?: boolean; timeoutMs?: number };
}

/** A plain-object session whose run() hands back one canned result. */
function fakeSession(result: EngineRequestResult, runs: RecordedRun[]): ExifToolSession {
  const session = {
    run: async (args: readonly string[], opts: { json?: boolean; timeoutMs?: number } = {}) => {
      runs.push({ args, opts });
      return result;
    },
  };
  return session as unknown as ExifToolSession;
}

/**
 * A canned in-band diagnostic with the JSON key it arrived under — the real
 * payload carries the key (what separates a genuine 'Error' from a real tag
 * whose name ends in Error), so the fakes carry it too.
 */
type CannedDiagnostic = ExifDiagnostic & { key?: string };

/** One canned engine response: the parsed JSON docs plus any in-band diagnostics. */
function cannedResult(json: unknown[], diagnostics: CannedDiagnostic[] = []): EngineRequestResult {
  return { executeNumber: 1, json, stdout: '', stderr: '', diagnostics };
}

describe('readTagValues classification', () => {
  it('returns values and marks the path as read when the engine answers with a document', async () => {
    const runs: RecordedRun[] = [];
    const winPath = 'C:\\Photos\\IMG_0001.PNG';
    const readback = await readTagValues(
      fakeSession(
        cannedResult([{ SourceFile: winPath, 'XMP-dc:Title': 'hello', 'EXIF:Software': 'TestApp' }]),
        runs,
      ),
      [winPath],
      ['XMP-dc:Title', 'EXIF:Software'],
    );

    // The doc came back under the normalized key (backslashes + case folded),
    // the same key the pipeline matches files by.
    expect([...readback.readPaths]).toEqual(['c:/photos/img_0001.png']);
    expect(readback.readErrors.size).toBe(0);
    expect(readback.values.get('c:/photos/img_0001.png')).toEqual({
      'XMP-dc:Title': 'hello',
      'EXIF:Software': 'TestApp',
    });
    // The read is the same -j -G1 -a -struct JSON round trip with the
    // batch-scaled timeout (60s + 500ms for the one file).
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args.slice(0, 4)).toEqual(['-j', '-G1', '-a', '-struct']);
    expect(runs[0]?.args.at(-1)).toBe(winPath);
    expect(runs[0]?.opts.json).toBe(true);
    expect(runs[0]?.opts.timeoutMs).toBe(60_500);
  });

  it('reports an in-band error as a read error, never as data or a reached file', async () => {
    const winPath = 'C:\\Photos\\broken.png';
    const readback = await readTagValues(
      fakeSession(
        cannedResult(
          // The engine answers an unreadable file with an error document
          // (SourceFile echoed) plus the error diagnostic for it.
          [{ SourceFile: winPath, Error: 'Unknown file type' }],
          [
            {
              severity: 'error',
              key: 'Error',
              message: 'Unknown file type',
              sourceFile: winPath,
            },
          ],
        ),
        [],
      ),
      [winPath],
      ['XMP-dc:Title'],
    );

    expect(readback.readErrors.get('c:/photos/broken.png')).toBe('Unknown file type');
    expect(readback.readPaths.has('c:/photos/broken.png')).toBe(false);
    // An error document carries no tag values — reading it as {}-tags would
    // be exactly the vacuous verify of issue #3.
    expect(readback.values.get('c:/photos/broken.png')).toEqual({});
  });

  it('leaves a path the engine answered nothing for out of both readPaths and readErrors', async () => {
    const winPath = 'C:\\Photos\\silent.png';
    // Empty stdout resolves to zero documents — the read produced nothing.
    const readback = await readTagValues(
      fakeSession(cannedResult([]), []),
      [winPath],
      ['XMP-dc:Title'],
    );

    expect(readback.readPaths.size).toBe(0);
    expect(readback.readErrors.size).toBe(0);
    // The values map still keys every requested path (the callers' `?? {}`
    // lookups keep working) — but with no values in it.
    expect(readback.values.get('c:/photos/silent.png')).toEqual({});
  });

  it('classifies each path in one call independently', async () => {
    const readPath = 'C:\\p\\read.png';
    const errorPath = 'C:\\p\\error.png';
    const silentPath = 'C:\\p\\silent.png';
    const readback = await readTagValues(
      fakeSession(
        cannedResult(
          // A genuine in-band error travels as its own document (SourceFile
          // echoed) plus the diagnostic for it — the engine's real shape.
          [
            { SourceFile: readPath, 'XMP-dc:Title': 'present' },
            { SourceFile: errorPath, Error: 'Format error' },
          ],
          [
            {
              severity: 'error',
              key: 'Error',
              message: 'Format error',
              sourceFile: errorPath,
            },
          ],
        ),
        [],
      ),
      [readPath, errorPath, silentPath],
      ['XMP-dc:Title'],
    );

    // Read: doc present, values populated.
    expect([...readback.readPaths]).toEqual(['c:/p/read.png']);
    expect(readback.values.get('c:/p/read.png')).toEqual({ 'XMP-dc:Title': 'present' });
    // Error: the error document lands in readErrors only.
    expect([...readback.readErrors.keys()]).toEqual(['c:/p/error.png']);
    expect(readback.readErrors.get('c:/p/error.png')).toBe('Format error');
    expect(readback.readPaths.has('c:/p/error.png')).toBe(false);
    expect(readback.values.get('c:/p/error.png')).toEqual({});
    // Silent: in neither set, empty values entry.
    expect(readback.readPaths.has('c:/p/silent.png')).toBe(false);
    expect(readback.readErrors.has('c:/p/silent.png')).toBe(false);
    expect(readback.values.get('c:/p/silent.png')).toEqual({});
  });

  // A doc carrying exiftool's RESERVED Warning key (real files with
  // damaged-but-readable metadata warn like this while still returning every
  // value) is a NOTE, not a read failure: the read reached the file, the
  // values are comparable, and treating it as an error would fail
  // verification on a perfectly healthy read — forever, since the retry hits
  // the same warning.
  it('treats a reserved Warning doc as a reached file with data, never as a read error', async () => {
    const winPath = 'C:\\Photos\\warny.png';
    const readback = await readTagValues(
      fakeSession(
        cannedResult([
          {
            SourceFile: winPath,
            Warning: '[minor] Bad format for XMP structure',
            'XMP-dc:Title': 'kept',
          },
        ]),
        [],
      ),
      [winPath],
      ['XMP-dc:Title'],
    );

    // RED today: the warning lands in readErrors and the file is dropped
    // from readPaths, so verification would fail a healthy, fully-readable
    // file.
    expect(readback.readErrors.has('c:/photos/warny.png')).toBe(false);
    expect(readback.readPaths.has('c:/photos/warny.png')).toBe(true);
    expect(readback.values.get('c:/photos/warny.png')).toEqual({ 'XMP-dc:Title': 'kept' });
  });

  // Regression (real engine, gpsStrip undo false failure): a HEALTHY GPS
  // photo's read doc carries 'GPS:GPSHPositioningError': '1.5 m' — a real
  // tag whose NAME ends in Error. The shared extractor files it as an error
  // diagnostic; the readback must not. A healthy GPS read is a reached file
  // with data, never a read error.
  it('treats a real tag ending in Error (GPS:GPSHPositioningError) as data, not as a read error', async () => {
    const winPath = 'C:\\Photos\\gps-photo.png';
    const readback = await readTagValues(
      fakeSession(
        cannedResult(
          [{ SourceFile: winPath, 'GPS:GPSHPositioningError': '1.5 m', 'XMP-dc:Title': 'kept' }],
          [
            {
              severity: 'error',
              key: 'GPS:GPSHPositioningError',
              message: '1.5 m',
              sourceFile: winPath,
            },
          ],
        ),
        [],
      ),
      [winPath],
      ['GPS:GPSHPositioningError', 'XMP-dc:Title'],
    );

    // The file counts as reached, carries no read error, and the GPS value
    // reads back as DATA.
    expect(readback.readPaths.has('c:/photos/gps-photo.png')).toBe(true);
    expect(readback.readErrors.has('c:/photos/gps-photo.png')).toBe(false);
    expect(readback.values.get('c:/photos/gps-photo.png')).toEqual({
      'GPS:GPSHPositioningError': '1.5 m',
      'XMP-dc:Title': 'kept',
    });
  });
});
