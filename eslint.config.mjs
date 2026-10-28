// ESLint (npm run lint): server modules, the shared browser scripts and the inline <script> of every page
import js from '@eslint/js';
import html from 'eslint-plugin-html';
import globals from 'globals';

// Set on window by the shared scripts (globals.d.ts has their types)
const shared = Object.fromEntries(['api', 'DESK', 'ORG', 'ThaiDate', 'TextTools', 'Sortable', 'StoryPick', 'VideoLinks', 'NAME_PREFIXES']
  .map((name) => [name, 'readonly']));

export default [
  { ignores: ['node_modules/', 'assets/', 'uploads/', 'backups/', 'screenshots/', 'brand_assets/'] },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }], // catch {}: a best-effort step that may fail quietly
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  { files: ['server/**/*.mjs', '.claude/hooks/*.mjs', '*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...shared } } },
  { files: ['*.html'], plugins: { html }, languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...shared } } },
  // Page scripts may reuse a browser name (open, when) for their own function; shared names (api) are still checked
  { files: ['*.js', '*.html'], languageOptions: { globals: { open: 'off' } }, rules: { 'no-redeclare': ['error', { builtinGlobals: false }] } },
  { files: ['login.html'], languageOptions: { globals: { google: 'readonly' } } }, // Google sign-in script
];
