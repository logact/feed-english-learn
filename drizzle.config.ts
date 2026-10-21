import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/engine/schema.ts",
  dbCredentials: {
    url: process.env.ENGINE_DB_PATH ?? "data/engine.db",
  },
});
