import { defineConfig } from "vitest/config";

process.env.ANORVIS_CREDENTIAL_KEY =
  "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=";

export default defineConfig({
  test: {
    environment: "edge-runtime",
  },
});
