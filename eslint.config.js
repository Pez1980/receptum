import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "packages/*/scripts/**/*.mjs", "examples/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
);
