import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{js,jsx,mjs}", "vite.config.ts", "eslint.config.js"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{js,jsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["tests/**/*.mjs", "vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
