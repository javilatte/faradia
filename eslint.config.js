'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'vendor/**', 'test-results/**', 'playwright-report/**', '.optimia/**', '.codegraph/**']
  },
  js.configs.recommended,
  {
    // Node: server, launcher, MCP server and tests (CommonJS)
    files: ['server/**/*.js', 'bin/**', 'test/**/*.js', '*.config.js', 'test/e2e/fixtures/bin/claude'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  },
  {
    // Project view: classic browser scripts loaded in order that share one
    // global scope on purpose (see web/index.html), so cross-file references
    // are not undefined and functions used from another file are not unused.
    files: ['web/js/project/**/*.js', 'web/terminal.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly' }
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off'
    }
  },
  {
    // ES modules: every new view, with the full rule set
    files: ['web/js/**/*.mjs', 'web/js/app/**/*.js', 'web/orb.js', 'web/glance.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  }
];
