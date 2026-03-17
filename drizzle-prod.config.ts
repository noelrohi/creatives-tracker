import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*",
  dbCredentials: {
    url: process.env.PRODUCTION_DATABASE_URL!,
  },
});
