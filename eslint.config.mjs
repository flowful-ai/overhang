import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Pin the React version explicitly. eslint-config-next bundles
  // eslint-plugin-react@7.37.5, whose "detect" code path calls the
  // context.getFilename() API that ESLint 10 removed — leaving it on the
  // default "detect" crashes `eslint` outright. A literal version skips
  // detection entirely.
  {
    settings: {
      react: { version: "19.2" },
    },
    rules: {
      // Honor the codebase's "_"-prefix convention for deliberately unused
      // bindings (destructured throwaways like `_omit`, ignored callback args).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // eslint-plugin-react-hooks 7's react-compiler-aligned rules are prone to
      // false positives on legitimate patterns (object-URL lifecycle effects,
      // fetch-on-mount, deferred ref reads, `window.location` navigation). The
      // current known sites are each fixed or carry a justified
      // eslint-disable; keep these at "warn" as a low-friction safety net so a
      // future false positive doesn't block CI while real smells stay visible.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // cad-worker is a standalone Python service; its local .venv would
    // otherwise drag thousands of vendored JS files into the JS lint.
    "cad-worker/**",
  ]),
]);

export default eslintConfig;
