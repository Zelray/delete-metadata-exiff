/**
 * Split a typed console line into an argv array.
 *
 * The Console view collects a command as plain text but the API contract
 * takes `args: string[]` — argument-array execution only, never a shell
 * string (BUILD-NOTES / data-safety). This splitter is a tokenizer, NOT a
 * shell: it honors double and single quotes and nothing else. There is no
 * expansion, no operator handling, no interpolation — the tokens go to the
 * server's read-only validator verbatim.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0 || started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (current.length > 0 || started) args.push(current);
  return args;
}
