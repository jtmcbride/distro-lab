import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // noUncheckedIndexedAccess is on; `!` after a bounds check is the intended escape hatch.
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      // Determinism: simulation code must use the engine's clock and seeded RNG.
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the seeded Rng." },
        { object: "Date", property: "now", message: "Use virtual time." },
        { object: "performance", property: "now", message: "Use virtual time." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "setTimeout", message: "Schedule a timer effect instead." },
        { name: "setInterval", message: "Schedule a timer effect instead." },
      ],
    },
  },
);
