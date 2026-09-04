import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }]
    }
  },
  {
    // The npm launcher is CommonJS on purpose: it must run under plain Node.
    files: ["bin/ggh.cjs", "scripts/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", __dirname: "readonly", process: "readonly", console: "readonly", Bun: "readonly" }
    },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    ignores: ["dist/", "node_modules/"]
  }
);
