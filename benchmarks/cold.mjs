// Copy into an isolated npm project with either CMS + its Postgres adapter.
// Each invocation is a fresh process, with warm OS filesystem caches.
const start = performance.now();
const target = process.argv[2];
let imported;
if (target === "payload") {
  const { buildConfig } = await import("payload");
  const { postgresAdapter } = await import("@payloadcms/db-postgres");
  imported = performance.now();
  await buildConfig({
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
  });
} else if (target === "heyo") {
  const { heyoCms, defineCollection } = await import("@heyo-sh/heyo-cms");
  const { text, textarea } = await import("@heyo-sh/heyo-cms/fields");
  const { postgres } = await import("@heyo-sh/heyo-cms/postgres");
  imported = performance.now();
  heyoCms({
    database: postgres("postgres://127.0.0.1:1/unreachable"),
    collections: Object.fromEntries(
      ["posts", "pages"].map((slug) => [
        slug,
        defineCollection({
          fields: { title: text({ required: true }), body: textarea() },
        }),
      ]),
    ),
  });
} else {
  throw new Error("Usage: node cold.mjs heyo|payload");
}
const end = performance.now();
console.log(
  JSON.stringify({
    target,
    importMs: +(imported - start).toFixed(1),
    configMs: +(end - imported).toFixed(1),
    totalMs: +(end - start).toFixed(1),
  }),
);
