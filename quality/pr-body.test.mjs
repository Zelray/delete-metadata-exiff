import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBody } from './pr-body.mjs';

const command = fileURLToPath(new URL('./pr-body.mjs', import.meta.url));

test('rejects empty and comment-only acceptance through the real command', () => {
  for (const body of ['## Acceptance\n', '## Acceptance\n<!-- placeholder -->\n## Spec\nA spec']) {
    const result = spawnSync(process.execPath, [command], {
      env: { ...process.env, PR_TITLE: 'fix: example', PR_BODY: body },
      encoding: 'utf8', shell: false,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs content under '## Acceptance'/);
  }
});

test('requires a spec for scoped and breaking feat titles', () => {
  for (const title of ['feat: example', 'feat(ui): example', 'feat(ui)!: example']) {
    assert.equal(checkBody(title, '## Acceptance\nA user-visible outcome').code, 1);
    assert.equal(checkBody(title, '## Acceptance\nA user-visible outcome\n## Spec\nNo separate spec needed.').code, 0);
  }
});

test('a code fence cannot impersonate an acceptance heading', () => {
  const body = '```markdown\n## Acceptance\nFake section\n```\n## Checks run\nTests';
  assert.equal(checkBody('fix: example', body).code, 1);
});

test('headings inside accepted fenced code do not truncate the section', () => {
  assert.equal(checkBody('fix: example', '## Acceptance\n```text\n## Example\nExpected output\n```').code, 0);
});

test('malformed fences and attached hashes cannot create required sections', () => {
  for (const body of [
    '```markdown\n```not-a-close\n## Acceptance\nFake section\n```',
    '## Acceptance#\nFake section',
    '## Acceptance\n# Other\nUnrelated content',
  ]) {
    const result = spawnSync(process.execPath, [command], {
      env: { ...process.env, PR_TITLE: 'fix: example', PR_BODY: body },
      encoding: 'utf8', shell: false,
    });
    assert.equal(result.status, 1, body);
  }
  assert.equal(checkBody('feat: example', '## Acceptance\nOutcome\n## Spec#\nFake').code, 1);
});

test('unavailable input is an execution error', () => {
  assert.equal(checkBody('', undefined).code, 2);
});

test('stdin and shell-looking titles are handled as text', () => {
  const result = spawnSync(process.execPath, [command, '--stdin'], {
    input: '## Acceptance\nPreserve literal text\n## Spec\nSmall fixture',
    env: { ...process.env, PR_TITLE: 'feat: $(not_a_command); `literal`' },
    encoding: 'utf8', shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PR body sections present/);
});
