import js from '@eslint/js';
import globals from 'globals';

/*
 * The project previously had no real linter: the `lint` script only ran `node --check` on
 * three hardcoded files, so dead code and undefined references went unnoticed.
 *
 * Three environments are configured, because main, preload and renderer code each see a
 * different set of globals.
 */
export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'build-tools/**', 'out/**', 'recordings/**']
  },

  js.configs.recommended,

  {
    // Main process, preload bridges and build scripts: CommonJS with Node globals.
    files: ['src/main.js', 'src/main/**/*.js', 'src/preload*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },

  {
    // Renderer scripts: classic scripts sharing the RP4 namespace, plus the capture APIs
    // the pipeline relies on.
    files: ['src/renderer/**/*.js', 'src/area-selector.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        MediaRecorder: 'readonly',
        MediaStream: 'readonly',
        MediaStreamTrackProcessor: 'readonly',
        MediaStreamTrackGenerator: 'readonly',
        VideoFrame: 'readonly',
        AudioContext: 'readonly',
        OffscreenCanvas: 'readonly',
        TransformStream: 'readonly',
        RP4: 'writable'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Renderer modules are IIFEs attached to window.RP4, so top-level `this` is fine.
      'no-invalid-this': 'off'
    }
  },

  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
];
