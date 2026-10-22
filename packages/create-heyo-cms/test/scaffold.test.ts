import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextSteps, parseArguments } from "../src/index";
import {
  assertSupportedProjectOptions,
  D1_NEEDS_CLOUDFLARE_MESSAGE,
  scaffoldProject,
} from "../src/scaffold";
import { mergePackageJson, replacePlaceholders } from "../src/utils";
import {
  databases,
  deployments,
  storages,
  templates,
  type CreateOptions,
} from "../src/types";

/**
 * Stage 10: the generator, from the outside.
 *
 * What has to be true is narrow and checkable: every supported combination
 * produces a project, the project mounts the CMS from exactly one file, the
 * layers land in the right order, and nothing in the output still contains a
 * placeholder. Installing dependencies is the one thing not exercised here —
 * that is what `bun run example smoke` does, against a real framework and a
 * real database.
 */

describe("the generator", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "create-heyo-cms-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const create = async (
    overrides: Partial<CreateOptions> = {},
  ): Promise<string> => {
    const options: CreateOptions = {
      projectName: "my-cms",
      template: "next",
      deployment: "vercel",
      database: "postgres",
      storage: "local",
      packageManager: "bun",
      install: false,
      cwd: directory,
      ...overrides,
    };
    const { projectPath } = await scaffoldProject(options);
    return projectPath;
  };

  const read = (path: string): Promise<string> => readFile(path, "utf8");
  const exists = async (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );

  test("writes a project whose CMS is mounted from one file", async () => {
    const project = await create();

    const mount = join(project, "app/api/heyo-cms/[...path]/route.ts");
    expect(await exists(mount)).toBe(true);
    const source = await read(mount);
    expect(source).toContain("@heyo-sh/heyo-cms/next");
    expect(source).toContain("cmsHandler(cms)");

    const client = await read(join(project, "heyo-cms.client.ts"));
    expect(client).toContain("cmsClient = heyoCmsClient()");
    const clientTypes = await read(join(project, "heyo-cms.client.d.ts"));
    expect(clientTypes).toContain("typeof cms");
    expect(clientTypes).toContain("HeyoCmsClientRegistry");

    // The claim the whole design rests on: the routes are not files.
    const manifest = JSON.parse(
      await read(join(project, "package.json")),
    ) as Record<string, Record<string, string>>;
    expect(manifest.name as unknown).toBe("my-cms");
    expect(manifest.dependencies?.["@heyo-sh/heyo-cms"]).toBe("latest");
    expect(manifest.scripts?.["db:migrate"]).toBe("heyo-cms migrate");
    expect(manifest.scripts?.deploy).toBe("vercel --prod");
  });

  test("ships the same branded starter home in every framework", async () => {
    const homePaths = {
      next: "app/page.tsx",
      astro: "src/pages/index.astro",
      "react-router": "app/routes/home.tsx",
    } as const;
    const layoutPaths = {
      next: "app/layout.tsx",
      astro: "src/pages/index.astro",
      "react-router": "app/root.tsx",
    } as const;

    for (const template of templates) {
      const project = await create({
        template,
        projectName: `starter-${template}`,
      });
      const home = await read(join(project, homePaths[template]));
      expect(home).toContain("cms-hero");
      expect(home).toContain("/logo.svg");
      expect(home).toContain("A starter template powered by Heyo CMS.");
      const button =
        template === "astro"
          ? await read(join(project, "src/components/admin-panel-button.tsx"))
          : home;
      expect(button).toContain("Admin Panel");
      expect(button).toContain("@heyo-sh/heyo-ui/components/button");
      expect(button).toContain("/api/heyo-cms/admin");
      expect(home).not.toContain('href="/api/heyo-cms/posts"');
      expect(home).not.toContain('href="/api/heyo-cms/openapi.json"');
      expect(home).not.toContain("cms-eyebrow");
      expect(home).toContain('width="39"');
      expect(home).toContain("Latest posts");
      expect(home).toContain("data-theme-toggle");
      const layout = await read(join(project, layoutPaths[template]));
      expect(layout).toContain("/home.css");
      expect(layout).toContain("/home.js");
      const css = await read(join(project, "public/home.css"));
      expect(css).toContain(".cms-hero");
      expect(css).toContain(".cms-description");
      expect(css).toContain("max-width: 20rem");
      expect(css).toContain("font-size: 30px");
      const uiCss = template === "astro" ? "src/styles/ui.css" : "app/ui.css";
      const uiStyles = await read(join(project, uiCss));
      expect(uiStyles).toContain("@heyo-sh/heyo-ui");
      expect(uiStyles).toContain("@fontsource-variable/figtree");
      expect(await read(join(project, "public/home.js"))).toContain(
        "heyo-cms:theme",
      );
      expect(await read(join(project, "public/logo.svg"))).toContain("<svg");
      const manifest = JSON.parse(
        await read(join(project, "package.json")),
      ) as {
        dependencies: Record<string, string>;
      };
      expect(manifest.dependencies["@heyo-sh/heyo-ui"]).toBe("0.4.1");
      expect(manifest.dependencies["@fontsource-variable/figtree"]).toBe(
        "5.3.0",
      );
    }
  });

  test("layers the database, the storage and the deployment into one config", async () => {
    const project = await create({ database: "mongodb", storage: "s3" });

    // One file, and the only one that describes the CMS. The database, the
    // bucket and the image processor are *in* it — a generated project that
    // had to import three sibling modules would have made the first sentence
    // of its own configuration false.
    const config = await read(join(project, "heyo-cms.config.ts"));
    expect(config).toContain("mongodb");
    expect(config).toContain("s3(");
    // The deployment decides whether this runtime has a codec.
    expect(config).toContain("sharpImages");
    expect(config).toContain("const database");
    expect(config).toContain("const storage");
    expect(config).toContain("const images");
    expect(config).not.toContain("./heyo-cms.database");
    expect(config).not.toContain("./heyo-cms.storage");
    expect(config).not.toContain("./heyo-cms.images");

    for (const gone of [
      "heyo-cms.database.ts",
      "heyo-cms.storage.ts",
      "heyo-cms.images.ts",
    ]) {
      expect(await exists(join(project, gone))).toBe(false);
    }

    const manifest = JSON.parse(
      await read(join(project, "package.json")),
    ) as Record<string, Record<string, string>>;
    // The framework's dependency survived the overlays that came after it.
    expect(manifest.dependencies?.next).toBeDefined();
    expect(manifest.dependencies?.mongodb).toBeDefined();
    expect(manifest.dependencies?.sharp).toBeDefined();
  });

  test("assembles one .env.example from the layers that need a variable", async () => {
    const postgres = await create({ storage: "s3" });
    const env = await read(join(postgres, ".env.example"));
    expect(env).toContain("CRON_SECRET=");
    expect(env).toContain("DATABASE_URL=postgres://");
    expect(env).toContain("S3_BUCKET=");
    // A reader must not be offered a variable for a database they did not
    // choose; that is how the wrong one gets set.
    expect(env).not.toContain("MONGODB_URL");
    expect(await exists(join(postgres, "env.fragment"))).toBe(false);
  });

  test("merges wrangler.json across the deployment and the database", async () => {
    const project = await create({
      template: "react-router",
      deployment: "cloudflare",
      database: "d1",
      storage: "r2",
    });

    const wrangler = JSON.parse(
      await read(join(project, "wrangler.json")),
    ) as Record<string, unknown>;
    expect(wrangler.name).toBe("my-cms");
    expect(wrangler.main).toBe("./workers/app.ts");
    // The binding comes from the database layer, which knows nothing about
    // the Worker it is being added to.
    expect(wrangler.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "my-cms",
        database_id: "local",
        migrations_dir: "migrations",
      },
    ]);
    expect((wrangler.triggers as { crons: string[] }).crons).toHaveLength(1);

    // And the Worker runs the sweeps from the platform's clock.
    expect(await read(join(project, "workers/app.ts"))).toContain("cmsScheduled"); // prettier-ignore
  });

  test("gives every combination a cache the write hooks can empty", async () => {
    // The views tag what they read and the configuration purges the same
    // tags. What differs between deployments is only who is holding the copy,
    // so the file that knows that — and nothing else — is replaced per
    // platform. If these two halves ever disagree about a spelling, the site
    // goes stale silently, which is why the names are asserted rather than
    // the mechanism.
    const expected: Record<string, Record<string, string>> = {
      next: { vercel: "next/cache", cloudflare: "next/cache" },
      astro: { vercel: "@vercel/functions", cloudflare: "purge_cache" },
      "react-router": {
        vercel: "@vercel/functions",
        cloudflare: "purge_cache",
      },
    };

    for (const template of templates) {
      for (const deployment of deployments) {
        const project = await create({
          projectName: `cache-${template}-${deployment}`,
          template,
          deployment,
          storage: deployment === "cloudflare" ? "r2" : "s3",
        });

        const cache = await read(join(project, "heyo-cms.cache.ts"));
        expect(`${template}/${deployment}: ${cache}`).toContain(
          (expected[template] as Record<string, string>)[deployment] as string,
        );
        expect(cache).toContain('export const postsTag = "posts"');

        // The other half: a write purges what a view tagged.
        const config = await read(join(project, "heyo-cms.config.ts"));
        expect(config).toContain('from "./heyo-cms.cache.ts"');
        expect(config).toContain("revalidatePosts(postTags(doc))");
      }
    }
  });

  test("renames the shipped gitignore, which npm will not publish as a dotfile", async () => {
    const project = await create();
    expect(await exists(join(project, ".gitignore"))).toBe(true);
    expect(await exists(join(project, "gitignore"))).toBe(false);
    expect(await read(join(project, ".gitignore"))).toContain("node_modules");
  });

  test("produces every supported combination, with no placeholder left", async () => {
    let produced = 0;
    for (const template of templates) {
      for (const deployment of deployments) {
        for (const database of databases) {
          if (database === "d1" && deployment !== "cloudflare") continue;
          const name = `${template}-${deployment}-${database}`;
          const project = await create({
            projectName: name,
            template,
            deployment,
            database,
            storage: deployment === "cloudflare" ? "r2" : "s3",
          });
          produced += 1;

          const manifest = JSON.parse(await read(join(project, "package.json"))) as Record<string, unknown>; // prettier-ignore
          expect(manifest.name).toBe(name);
          expect(JSON.stringify(manifest)).not.toContain("{{");

          for (const file of [
            "heyo-cms.config.ts",
            "heyo-cms.client.ts",
            "heyo-cms.client.d.ts",
            "heyo-cms.cache.ts",
            "heyo-cms.seed.ts",
            "README.md",
            "DEPLOYMENT.md",
            ".env.example",
          ]) {
            const contents = await read(join(project, file));
            expect(`${file}: ${contents}`).not.toContain("{{");
          }

          // No fragment ever reaches a generated project: they are pieces of
          // files, and a reader finding `config.storage.fragment` next to
          // their config would reasonably wonder which one is live.
          const stray = (await readdir(project)).filter((name) =>
            name.endsWith(".fragment"),
          );
          expect(stray).toEqual([]);
        }
      }
    }
    // 3 frameworks × 2 deployments × 3 databases, minus D1 anywhere but
    // Cloudflare.
    expect(produced).toBe(15);
  });

  test("every storage choice names its adapter in the configuration", async () => {
    for (const storage of storages) {
      const project = await create({ projectName: `s-${storage}`, storage });
      const source = await read(join(project, "heyo-cms.config.ts"));
      expect(source).toContain(`${storage === "local" ? "local" : storage}(`);
    }
  });

  test("refuses D1 outside Cloudflare, and says what D1 is", async () => {
    expect(() =>
      assertSupportedProjectOptions({ deployment: "vercel", database: "d1" }),
    ).toThrow(D1_NEEDS_CLOUDFLARE_MESSAGE);
    await expect(
      create({ projectName: "nope", deployment: "vercel", database: "d1" }),
    ).rejects.toThrow(/Cloudflare database/);
  });

  test("rejects local filesystem storage on Workers and supplies usable defaults", async () => {
    await expect(
      create({ deployment: "cloudflare", database: "d1", storage: "local" }),
    ).rejects.toThrow(/Local filesystem/);
    const { options } = parseArguments([
      "my-worker",
      "--deployment",
      "cloudflare",
    ]);
    expect(options.database).toBe("d1");
    expect(options.storage).toBe("r2");
  });

  test("refuses a name that is not a directory, a package and a hostname", async () => {
    await expect(create({ projectName: "My CMS" })).rejects.toThrow(/hyphens/);
    await expect(create({ projectName: "" })).rejects.toThrow(/project name/);
  });

  test("refuses to write into a directory that already exists", async () => {
    await create({ projectName: "twice" });
    await expect(create({ projectName: "twice" })).rejects.toThrow(
      /already exists/,
    );
  });

  test("writes the version the caller asked for, which is how the examples are built", async () => {
    const project = await create({ heyoCmsVersion: "workspace:*" });
    const manifest = JSON.parse(
      await read(join(project, "package.json")),
    ) as Record<string, Record<string, string>>;
    expect(manifest.dependencies?.["@heyo-sh/heyo-cms"]).toBe("workspace:*");
    expect(manifest.dependencies?.["@heyo-sh/heyo-cms-admin"]).toBe("workspace:*"); // prettier-ignore
  });
});

describe("the command line", () => {
  test("reads every flag, and defaults the rest", () => {
    const { options, interactive } = parseArguments([
      "my-cms",
      "--template",
      "astro",
      "--deployment",
      "cloudflare",
      "--database",
      "d1",
      "--storage",
      "r2",
      "--package-manager",
      "pnpm",
      "--no-install",
    ]);
    expect(interactive).toBe(false);
    expect(options).toEqual({
      projectName: "my-cms",
      template: "astro",
      deployment: "cloudflare",
      database: "d1",
      storage: "r2",
      packageManager: "pnpm",
      install: false,
    });
  });

  test("asks when it was given nothing, and refuses what it cannot parse", () => {
    expect(parseArguments([]).interactive).toBe(true);
    expect(parseArguments(["my-cms"]).interactive).toBe(false);
    expect(parseArguments(["--help"]).showHelp).toBe(true);
    expect(() => parseArguments(["--template", "svelte"])).toThrow(/next, astro/); // prettier-ignore
    expect(() => parseArguments(["--database", "mysql"])).toThrow(/postgres/);
    expect(() => parseArguments(["--wat"])).toThrow(/Unknown option/);
  });

  test("the next steps are the commands that have to be run, in order", () => {
    const steps = nextSteps({
      projectName: "my-cms",
      template: "next",
      deployment: "vercel",
      database: "postgres",
      storage: "s3",
      packageManager: "npm",
      install: true,
    });
    expect(steps.split("\n")[0]).toBe("cd my-cms");
    expect(steps).toContain("cp .env.example .env");
    expect(steps).toContain("npm run db:migrate");
    expect(steps).toContain("npm run dev");
    // Not among them any more: the panel asks for the administrator itself on
    // a CMS that has no accounts, and a command nobody has to run is one
    // fewer step between `create` and a screen to type into.
    expect(steps).not.toContain("create-admin");
    // Nothing to copy on D1: the binding is in wrangler.json.
    const d1 = nextSteps({
      projectName: "my-cms",
      template: "react-router",
      deployment: "cloudflare",
      database: "d1",
      storage: "r2",
      packageManager: "bun",
      install: false,
    });
    expect(d1).toContain("bun install");
    expect(d1).not.toContain("cp .env.example");
  });
});

describe("the helpers", () => {
  test("replaces placeholders and leaves unknown ones alone", () => {
    expect(replacePlaceholders("{{A}}/{{B}}", { A: "x" })).toBe("x/{{B}}");
  });

  test("merges a manifest deeply, leaf by leaf", () => {
    expect(
      mergePackageJson(
        { scripts: { dev: "next dev" }, dependencies: { next: "16" } },
        { scripts: { deploy: "vercel" }, dependencies: { next: "17" } },
      ),
    ).toEqual({
      scripts: { dev: "next dev", deploy: "vercel" },
      dependencies: { next: "17" },
    });
  });
});
