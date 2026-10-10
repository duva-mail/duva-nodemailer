// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    ignores: ["dist/**", "coverage/**"],
  },
  {
    rules: {
      // Les extensions du contrat (x-retryable, x-safe-retry...) arrivent en `unknown`/`any` du
      // JSON généré : on les affine nous-mêmes dans src/, pas la peine que le lint s'y oppose.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { fetch: "readonly", console: "readonly", process: "readonly" },
    },
  },
  {
    // Les tests narrowent souvent un tableau déjà vérifié non vide (`it.each`, `[case] = ...
    // filter(...)`) : le `!` y est un raccourci lisible, pas un risque de production.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  }
);
