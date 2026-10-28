'use strict';
// Lint rules for the whole repository: `npm run lint`. The server, agent tools and scripts are Node (CommonJS);
// public/ holds plain browser scripts that share globals across files, so undefined names are not checked there.
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-control-regex': 'off',
  'no-useless-escape': 'off',
  'no-cond-assign': ['error', 'except-parens'],
};

module.exports = [
  { ignores: ['node_modules/', 'data/', 'teams/', 'backups/', 'inbox/', 'artifacts/'] },
  js.configs.recommended,
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node }, rules },
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser }, rules: { ...rules, 'no-undef': 'off', 'no-unused-vars': 'off' } },
];
