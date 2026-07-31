import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react",
              message:
                "Import icons from @/components/icons (Solar via @iconify/react).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Installed skills are vendored from other repos and follow their authors'
    // conventions, not ours — linting them only ever reports someone else's
    // house style back at us.
    ".agents/skills/**",
    // Default ignores of eslint-config-next:
    ".claude/worktrees/**",
    ".next/**",
    ".trigger/**",
    "cli/dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
