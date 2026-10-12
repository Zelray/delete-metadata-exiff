/** Each anchor occurs exactly once in its tracked HEAD source. */
export const MUTATIONS = Object.freeze([
  Object.freeze({
    id: 'engine-overwrite',
    file: 'server/src/engine/engineArgs.ts',
    from: 'if (isOverwriteFlag(arg)) {',
    to: 'if (!isOverwriteFlag(arg)) {',
    test: 'server/test/argBuilder.test.ts',
    testName: 'rejects an overwrite flag wherever it appears in the argv',
  }),
  Object.freeze({
    id: 'write-unlock',
    file: 'server/src/services/writePipeline.ts',
    from: 'if (!this.isWriteUnlocked()) {',
    to: 'if (this.isWriteUnlocked()) {',
    test: 'server/test/write/writePipeline.test.ts',
    testName: 'refuses execute while the session is read-only',
  }),
  Object.freeze({
    id: 'ui-blockers',
    file: 'ui/src/components/SaveReviewModal.tsx',
    from: 'const canExecute = !busy && phraseOk && counts.blockers.length === 0 && counts.files > 0;',
    to: 'const canExecute = !busy && phraseOk && counts.blockers.length !== 0 && counts.files > 0;',
    test: 'ui/src/write/write.surfaces.test.tsx',
    testName: 'disables execute while blockers stand',
  }),
  Object.freeze({
    id: 'api-token',
    file: 'ui/src/api/client.ts',
    from: "if (token !== '') headers['X-MetaDesk-Token'] = token;",
    to: "if (token === '') headers['X-MetaDesk-Token'] = token;",
    test: 'ui/src/api/client.transport.test.ts',
    testName: 'getThumbnail sends token-ONLY headers',
  }),
]);

export function applyMutation(source, target) {
  if (!target.from || target.from === target.to) throw new Error(`Invalid mutation anchor: ${target.id}`);
  const occurrences = source.split(target.from).length - 1;
  if (occurrences !== 1) throw new Error(`${target.id}: anchor occurrences=${occurrences}, expected exactly 1`);
  return source.replace(target.from, target.to);
}
