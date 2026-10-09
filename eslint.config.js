import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      ".gstack/**",
      ".kilo/**",
      ".worktrees/**",
      // Private review evidence; never part of the public source.
      ".audit/**",
      "coverage/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plugin helper scripts run under Node outside the TypeScript workspaces.
    files: ["herdr-plugin/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly" },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
