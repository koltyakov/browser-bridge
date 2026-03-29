import js from '@eslint/js';
import globals from 'globals';

const browserGlobals = {
  ...globals.browser,
  ...globals.serviceworker,
  chrome: 'readonly'
};

const nodeGlobals = {
  ...globals.node
};

export default [
  {
    ignores: [
      'assets/**',
      'dist/**',
      'node_modules/**',
      'packages/extension/assets/**',
      'packages/extension/ui/**/*.css',
      'packages/extension/ui/**/*.html',
      'tmp/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      indent: ['error', 2, { SwitchCase: 1 }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-useless-assignment': 'off',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_'
      }],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always']
    }
  },
  {
    files: ['packages/extension/src/**/*.js', 'packages/extension/ui/**/*.js'],
    languageOptions: {
      globals: browserGlobals
    }
  },
  {
    files: ['packages/**/*.test.js'],
    languageOptions: {
      globals: nodeGlobals
    }
  },
  {
    files: [
      'packages/**/*.js',
      'scripts/**/*.mjs'
    ],
    ignores: [
      'packages/extension/src/**/*.js',
      'packages/extension/ui/**/*.js'
    ],
    languageOptions: {
      globals: nodeGlobals
    }
  }
];
