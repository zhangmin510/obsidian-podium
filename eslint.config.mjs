// Mirrors the Obsidian community directory's automated review (eslint-plugin-obsidianmd).
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default defineConfig([
  { ignores: ['main.js', 'node_modules/**', 'test/**', 'esbuild.config.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['src/*.js', 'eslint.config.mjs'],
        },
      },
    },
  },
]);
