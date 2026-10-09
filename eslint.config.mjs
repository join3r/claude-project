// ESLint flat config. `npm run lint` must exit 0; warnings are allowed.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '.claude/**', 'coverage/**',
      // Committed esbuild bundles, not source (site/server is npm run build:installer's).
      'index.js', 'site/server/**',
      // The relay and the iOS app have their own tooling and lint configs.
      'relay/**', 'ios/**',
      // Task worktrees: full checkouts of other branches, linted in their own right.
      '.worktrees/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Only the two classic hook rules. The plugin's v7 "recommended" set also enables
      // the React Compiler rules (refs, purity, set-state-in-effect, ...), which this
      // codebase does not target.
      'react-hooks/rules-of-hooks': 'error',
      // Warn only: adding deps to silence this changes effect behavior.
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      // Deliberate best-effort `catch {}` swallows are common (fs cleanup, webview calls).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Terminal code matches ANSI escape sequences (\x1b, \x07) on purpose.
      'no-control-regex': 'off',
      // `interface X extends Y {}` names IPC request types; keep it allowed.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // New in ESLint 10: rethrowing without `{ cause }`. Useful, but opt-in cleanup.
      'preserve-caught-error': 'warn'
    }
  },
  {
    // The host runs without Electron too (the DevTool server): it reaches the process
    // through HostEnv and the windows through ClientHub, never through Electron itself.
    // The desktop's server hub and the server itself are Electron-free as well.
    files: ['src/main/host/**', 'src/main/servers/**', 'src/server/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'electron', message: 'src/main/host runs without Electron; add what you need to HostEnv or ClientHub.' },
          { name: 'electron-updater', message: 'Updates are the desktop shell\'s (app-runtime.ts), not the host\'s.' }
        ]
      }]
    }
  },
  {
    files: ['tests/**'],
    rules: {
      // Test doubles cast freely (window.api mocks, partial fixtures).
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // CommonJS hooks electron-builder loads with require() (scripts/sign-win.cjs).
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
)
