import { buildConfig } from "payload";
import { postgresAdapter } from "@payloadcms/db-postgres";

export default buildConfig({
  secret: "benchmark-only-not-a-deployment-secret",
  db: postgresAdapter({
    pool: { connectionString: "postgres://127.0.0.1:1/unreachable" },
    push: false,
  }),
  collections: ["posts", "pages"].map((slug) => ({
    slug,
    fields: [
      { name: "title", type: "text", required: true },
      { name: "body", type: "textarea" },
    ],
  })),
  telemetry: false,
});
