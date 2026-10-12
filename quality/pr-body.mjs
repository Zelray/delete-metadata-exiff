import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function section(body, heading) {
  const clean = body.replace(/<!--[\s\S]*?-->/g, '');
  const lines = clean.split(/\r?\n/);
  let collecting = false;
  let fenced = false;
  let fenceChar = '';
  let fenceLength = 0;
  const content = [];
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!fenced) {
        fenced = true;
        fenceChar = fence[1][0];
        fenceLength = fence[1].length;
      } else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength
        && /^\s*$/.test(line.slice(fence[0].length))) {
        fenced = false;
      }
      if (collecting) content.push(line);
      continue;
    }
    if (!fenced) {
      const header = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
      if (header && header[1].length <= 2) {
        const name = (header[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
        collecting = header[1].length === 2 && name === heading;
        continue;
      }
    }
    if (collecting) content.push(line);
  }
  return content.join('\n').trim();
}

export function checkBody(title, body) {
  if (typeof title !== 'string' || typeof body !== 'string') {
    return { code: 2, messages: ['PR body check requires string title and body inputs.'] };
  }
  const messages = [];
  if (!section(body, 'Acceptance')) {
    messages.push("This PR needs content under '## Acceptance' after HTML comments are removed (P1).");
  }
  if (/^feat(?:\([^\n)]*\))?!?:/.test(title.trim()) && !section(body, 'Spec')) {
    messages.push("A feat PR needs '## Spec': a spec link or a reason it needs none.");
  }
  return { code: messages.length ? 1 : 0, messages };
}

function main() {
  const title = process.env.PR_TITLE ?? '';
  const body = process.argv.includes('--stdin') ? readFileSync(0, 'utf8') : process.env.PR_BODY;
  const result = checkBody(title, body);
  for (const message of result.messages) process.stderr.write(`${message}\n`);
  if (!result.code) process.stdout.write('PR body sections present.\n');
  return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
