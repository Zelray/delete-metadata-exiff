import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import i18next from 'eslint-plugin-i18next';

const scripts = ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'];
const typescript = ['**/*.{ts,tsx,mts,cts}'];
const uiProduction = ['ui/src/**/*.{ts,tsx}'];
const tests = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'ui/src/test/**'];
const nodeGlobals = Object.fromEntries([
  'process', 'Buffer', 'console', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'fetch', 'Headers', 'Request',
  'Response', 'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream',
  'TransformStream', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
  'performance', 'global', 'globalThis', 'crypto', 'atob', 'btoa',
].map((name) => [name, 'readonly']));
const textProps = /^(label|hint|title|description|message|placeholder|alt|confirmLabel|cancelLabel|aria-label|aria-description|aria-valuetext)$/;
const textSelector = String(textProps);
const copyMessage = 'C3: put user-facing text in ui/src/copy.ts and review all supported locales.';
const copySelectors = [
  `JSXAttribute[name.name=${textSelector}] > Literal[value=/\\S/]`,
  `JSXAttribute[name.name=${textSelector}] > JSXExpressionContainer Literal[value=/\\S/]`,
  `JSXAttribute[name.name=${textSelector}] > JSXExpressionContainer TemplateLiteral`,
  `Property[key.name=${textSelector}] > Literal.value[value=/\\S/]`,
  `Property[key.value=${textSelector}] > Literal.value[value=/\\S/]`,
  `Property[key.name=${textSelector}] > TemplateLiteral.value`,
  `Property[key.value=${textSelector}] > TemplateLiteral.value`,
  'CallExpression[callee.name=/^(toast|showToast|showDialog|alert|confirm|prompt)$/] > Literal.arguments[value=/\\S/]',
  'CallExpression[callee.name=/^(toast|showToast|showDialog|alert|confirm|prompt)$/] > TemplateLiteral.arguments',
  'CallExpression[callee.object.name="toast"][callee.property.name=/^(success|error|info|warning|message)$/] > Literal.arguments[value=/\\S/]',
  'CallExpression[callee.object.name="toast"][callee.property.name=/^(success|error|info|warning|message)$/] > TemplateLiteral.arguments',
].map((selector) => ({ selector, message: copyMessage }));

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-desktop/**', '**/target/**',
      '**/vendor/**', '**/data/**', '**/evidence/**', '**/.unlazy/**'],
  },
  { ...js.configs.recommended, files: scripts },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: typescript })),
  {
    files: scripts,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeGlobals },
    // A source directive must not hide a new finding from the baseline.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  {
    files: ['tests-e2e/**/*.{js,mjs,cjs,ts}'],
    // Playwright evaluate callbacks execute in the browser, with these globals.
    languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly' } },
  },
  {
    files: typescript,
    // TypeScript checks names, including browser and Node declarations.
    rules: { 'no-undef': 'off' },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ['ui/src/**/*.tsx'],
    ignores: tests,
  },
  {
    files: uiProduction,
    ignores: [...tests, 'ui/src/copy.ts'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', {
        framework: 'react',
        mode: 'jsx-only',
        'should-validate-template': true,
        words: { exclude: [] },
        'jsx-components': { exclude: [] },
      }],
      'no-restricted-syntax': ['error', ...copySelectors],
    },
  },
];
