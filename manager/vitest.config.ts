import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/policy-compiler",
      "packages/domain-api",
      "packages/web",
      { test: { name: "root", include: ["tests/**/*.test.ts"] } },
    ],
  },
});
