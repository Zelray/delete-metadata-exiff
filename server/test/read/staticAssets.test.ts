/**
 * Static-serving compatibility for the glob 14 security override (issue #26).
 *
 * These are characterization tests, not red-first bug tests: correct responses
 * must stay identical on glob 13 and glob 14. The pre-change production audit
 * is the red-first security oracle. The first test forces wildcard:false so
 * Fastify actually walks the fixture through glob. The second covers the
 * wildcard:true branch MetaDesk uses in production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

const ROOT_JS = 'console.log("root asset");\n';
const NESTED_CSS = 'body { color: rgb(1, 2, 3); }\n';
const UNICODE_NAME = 'ünïçødé file.js';
const UNICODE_JS = 'export const greeting = "héllo from a nested file";\n';
const HIDDEN_FILE = '.hidden.txt';

let staticRoot: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  // The root itself exercises Windows cwd handling with spaces and non-ASCII
  // characters, while the nested names exercise result-to-URL conversion.
  staticRoot = await mkdtemp(path.join(tmpdir(), 'metadesk static ünïcode '));
  await mkdir(path.join(staticRoot, 'assets', 'deep'), { recursive: true });
  await Promise.all([
    writeFile(path.join(staticRoot, 'root.js'), ROOT_JS),
    writeFile(path.join(staticRoot, 'assets', 'deep', 'site.css'), NESTED_CSS),
    writeFile(path.join(staticRoot, 'assets', 'deep', UNICODE_NAME), UNICODE_JS),
    writeFile(path.join(staticRoot, HIDDEN_FILE), 'must not be public'),
  ]);
});

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
  await rm(staticRoot, { recursive: true, force: true });
});

async function makeStaticApp(wildcard: boolean): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    index: false,
    decorateReply: false,
    wildcard,
  });
  await app.ready();
  return app;
}

async function expectAsset(
  target: FastifyInstance,
  url: string,
  expectedBody: string,
  expectedContentType: string,
): Promise<void> {
  const response = await target.inject({ method: 'GET', url });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain(expectedContentType);
  // Compare bytes, not just a status or a nonempty response, so a wrong asset
  // or a changed encoding cannot pass as a successful compatibility check.
  expect(response.rawPayload.equals(Buffer.from(expectedBody))).toBe(true);
}

describe('static asset compatibility', () => {
  it('walks root, nested, and Unicode assets through the glob-backed wildcard:false branch', async () => {
    const target = await makeStaticApp(false);

    await expectAsset(target, '/root.js', ROOT_JS, 'application/javascript');
    await expectAsset(target, '/assets/deep/site.css', NESTED_CSS, 'text/css');
    await expectAsset(
      target,
      `/assets/deep/${encodeURIComponent(UNICODE_NAME)}`,
      UNICODE_JS,
      'application/javascript',
    );

    const hidden = await target.inject({ method: 'GET', url: `/${HIDDEN_FILE}` });
    expect(hidden.statusCode).toBe(404);
  });

  it('serves the same assets through the production wildcard:true branch', async () => {
    const target = await makeStaticApp(true);

    await expectAsset(target, '/root.js', ROOT_JS, 'application/javascript');
    await expectAsset(target, '/assets/deep/site.css', NESTED_CSS, 'text/css');
    await expectAsset(
      target,
      `/assets/deep/${encodeURIComponent(UNICODE_NAME)}`,
      UNICODE_JS,
      'application/javascript',
    );

    const missing = await target.inject({ method: 'GET', url: '/assets/deep/missing.js' });
    expect(missing.statusCode).toBe(404);
  });
});
