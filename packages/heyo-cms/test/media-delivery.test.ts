import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { cmsHandler as astroHandler } from "../src/adapters/astro";
import { defineCollection, heyoCms, systemActor } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { richTextToHtml } from "../src/editor";
import { media, richText, text } from "../src/fields";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import type { ImagesConfig, UploadsConfig } from "../src/types/config";
import type { CmsEvent } from "../src/types/events";
import type { JsonObject, JsonValue } from "../src/types/json";
import type { ImageProcessor } from "../src/types/media";
import type { CmsPlugin } from "../src/types/plugin";
import { pngFixture, svgFixture } from "./images";

/**
 * Serving files and describing them for a page.
 *
 * The claims: a deployment with `uploads.publicPath` serves its own files at
 * addresses made for the web, through the same handler as the API; every URL
 * the CMS produces for a file points there; and the sizes a page offers in a
 * `srcset` are known — with their dimensions — before any of them has been
 * rendered, so a page of forty pictures costs one query.
 */

const actor = systemActor("usr_test");

/** Answers with the requested box, which is all URL arithmetic needs. */
function fakeProcessor(): ImageProcessor & { calls: number } {
  const state = { calls: 0 };
  const processor: ImageProcessor = {
    id: "fake",
    supports: (type) => type.startsWith("image/") && type !== "image/svg+xml",
    async transform(_source, transform, info) {
      state.calls++;
      const width = Math.min(transform.width ?? info.width, info.width);
      const height = Math.round((info.height * width) / info.width);
      const format = transform.format ?? info.format;
      return {
        data: pngFixture(width, height),
        contentType: `image/${format}`,
        width,
        height,
      };
    },
  };
  return Object.defineProperty(processor, "calls", {
    get: () => state.calls,
  }) as ImageProcessor & { calls: number };
}

const defaultImages = (processor: ImageProcessor): ImagesConfig => ({
  processor,
  convert: { to: "webp", keep: ["image/svg+xml"] },
  crop: true,
  focalPoint: true,
  variants: {
    mode: "on-demand",
    sizes: {
      thumb: { width: 320, height: 320, fit: "cover" },
      small: { width: 480 },
      card: { width: 800 },
      wide: { width: 1600 },
      hero: { width: 2400 },
    },
  },
});

async function setup(
  options: {
    uploads?: Partial<UploadsConfig>;
    images?: ImagesConfig | null;
    plugins?: CmsPlugin<unknown>[];
  } = {},
) {
  const adapter = sqlite(new Database(":memory:"));
  const processor = fakeProcessor();
  const images =
    options.images === null ? undefined : (options.images ?? defaultImages(processor)); // prettier-ignore
  const cms = heyoCms({
    database: () => adapter,
    collections: {
      posts: defineCollection({
        fields: {
          title: text({ required: true, localized: true }),
          cover: media({}),
          body: richText({ localized: true }),
        },
        access: { read: () => true, create: () => true, update: () => true },
      }),
    },
    i18n: { locales: ["en", "pl"], defaultLocale: "en" },
    uploads: {
      storage: memory({ baseUrl: "https://bucket.test" }),
      publicPath: "/media",
      ...(images === undefined ? {} : { images }),
      ...options.uploads,
    },
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_delivery"),
  );
  const upload = (width = 1200, height = 800, filename = "Łódź Report.png") =>
    cms.media.upload({
      file: pngFixture(width, height),
      filename,
      contentType: "image/png",
      alt: { en: "A report", pl: "Raport" },
      actor,
    });
  return { cms, processor, upload };
}

const get = (
  cms: { handler: (r: Request) => Promise<Response> },
  path: string,
  init?: RequestInit,
) =>
  // prettier-ignore
  cms.handler(new Request(`https://site.test${path}`, init));

describe("uploads.publicPath", () => {
  test("is validated where it is configured", () => {
    const build = (publicPath: string) => () =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: {},
        uploads: { storage: memory({ baseUrl: "https://b.test" }), publicPath },
      });
    expect(build("media")).toThrow(/must start with "\/"/);
    expect(build("/")).toThrow(/cannot be "\/"/);
    expect(build("/api/heyo-cms/files")).toThrow(/overlaps basePath/);
    expect(build("/api")).toThrow(/overlaps basePath/);
    expect(build("/me dia")).toThrow(/may only contain/);
    expect(build("/media/")).not.toThrow();
  });

  test("is where a file's url points", async () => {
    const { cms, upload } = await setup();
    const file = await upload();
    // Converted on upload, so the name says what is served.
    expect(file.mimeType).toBe("image/webp");
    expect(file.url).toBe(`/media/${file.id}/lodz-report.webp`);
    expect((await cms.media.get(file.id))?.url).toBe(file.url);
    await cms.close();
  });
});

describe("cms.media.url", () => {
  test("names the size and the format the size is served in", async () => {
    const { cms, upload } = await setup();
    const file = await upload();
    expect(cms.media.url(file)).toBe(`/media/${file.id}/lodz-report.webp`);
    expect(cms.media.url(file, { variant: "card" })).toBe(
      `/media/${file.id}/card/lodz-report.webp`,
    );
    // Wider than the file: the original, so the browser reuses it.
    expect(cms.media.url(file, { variant: "hero" })).toBe(file.url);
    expect(() => cms.media.url(file, { variant: "poster" })).toThrow(
      /No image size named "poster"/,
    );
    await cms.close();
  });

  test("without a public path, the API route", async () => {
    const { cms, upload } = await setup({ uploads: { publicPath: undefined } }); // prettier-ignore
    const file = await upload();
    expect(file.url).toStartWith("https://bucket.test/");
    expect(cms.media.url(file, { variant: "card" })).toBe(
      `/api/heyo-cms/media/${file.id}/card`,
    );
    expect(cms.media.url(file)).toBe(`/api/heyo-cms/media/${file.id}/original`);
    await cms.close();
  });

  test("without a processor, the original with the size in the query", async () => {
    const { cms, upload } = await setup({
      images: {
        variants: { mode: "on-demand", sizes: { card: { width: 800 } } },
      },
    });
    const file = await upload();
    expect(cms.media.url(file, { variant: "card" })).toBe(
      `/media/${file.id}/lodz-report.png?w=800`,
    );
    await cms.close();
  });
});

describe("cms.media.srcset and cms.media.image", () => {
  test("offer the sizes that keep the shape, with their real widths", async () => {
    const { cms, upload, processor } = await setup();
    const file = await upload(1200, 800);
    const id = file.id;
    // `thumb` crops to a square, so it is not the same picture; `wide` and
    // `hero` are the original at 1200.
    expect(cms.media.srcset(file)).toBe(
      [
        `/media/${id}/small/lodz-report.webp 480w`,
        `/media/${id}/card/lodz-report.webp 800w`,
        `/media/${id}/lodz-report.webp 1200w`,
      ].join(", "),
    );
    expect(
      cms.media.image(file, { sizes: "(min-width: 768px) 680px, 100vw", locale: "pl" }), // prettier-ignore
    ).toEqual({
      src: `/media/${id}/lodz-report.webp`,
      width: 1200,
      height: 800,
      srcset: cms.media.srcset(file),
      sizes: "(min-width: 768px) 680px, 100vw",
      alt: "Raport",
    });
    expect(cms.media.image(file, { variant: "thumb" })).toEqual({
      src: `/media/${id}/thumb/lodz-report.webp`,
      width: 320,
      height: 320,
      srcset: null,
      sizes: null,
      alt: "A report",
    });
    // Nothing was rendered to say any of this.
    expect(processor.calls).toBe(1);
    await cms.close();
  });

  test("with a crop, the cropped sizes only", async () => {
    const { cms, upload } = await setup();
    const file = await cms.media.update({
      id: (await upload(1200, 800)).id,
      crop: { x: 100, y: 0, width: 1000, height: 800 },
      actor,
    });
    const image = cms.media.image(file);
    // The original shows what the editor cut away; the largest size stands in.
    expect(image.src).toBe(`/media/${file.id}/wide/lodz-report.webp`);
    expect([image.width, image.height]).toEqual([1000, 800]);
    expect(image.srcset).not.toContain(`/media/${file.id}/lodz-report.webp`);
    expect(image.srcset).toContain("800w");
    await cms.close();
  });

  test("a vector has nothing to choose between", async () => {
    const { cms } = await setup();
    const file = await cms.media.upload({
      file: svgFixture(100, 100),
      filename: "logo.svg",
      contentType: "image/svg+xml",
      actor,
    });
    expect(cms.media.srcset(file)).toBeNull();
    expect(cms.media.image(file).src).toBe(`/media/${file.id}/logo.svg`);
    await cms.close();
  });
});

describe("the public route", () => {
  test("serves the original and a size, cacheably, through cms.handler", async () => {
    const { cms, upload } = await setup();
    const file = await upload();

    const original = await get(cms, `/media/${file.id}/anything-at-all.webp`);
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/webp");
    expect(original.headers.get("cache-control")).toBe("public, max-age=31536000, immutable"); // prettier-ignore
    expect(original.headers.get("x-content-type-options")).toBe("nosniff");
    await original.arrayBuffer();

    const card = await get(cms, `/media/${file.id}/card/lodz-report.webp`);
    expect(card.status).toBe(200);
    expect(card.headers.get("x-heyo-cms-cache")).toBe("miss");
    const etag = card.headers.get("etag")!;
    await card.arrayBuffer();

    const again = await get(cms, `/media/${file.id}/card/lodz-report.webp`, {
      headers: { "if-none-match": `W/${etag}, "other"` },
    });
    expect(again.status).toBe(304);

    const head = await get(cms, `/media/${file.id}/card/x.webp`, { method: "HEAD" }); // prettier-ignore
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).not.toBeNull();
    expect(await head.text()).toBe("");
    await cms.close();
  });

  test("answers 404 to guesses without touching storage", async () => {
    const { cms, upload } = await setup();
    const file = await upload();
    for (const path of [
      `/media/${file.id}/poster/x.webp`,
      `/media/med_doesnotexist/x.webp`,
      `/media/${encodeURIComponent("../etc")}/x.webp`,
    ]) {
      const response = await get(cms, path);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    }
    expect((await get(cms, `/media/${file.id}/x.webp`, { method: "POST" })).status).toBe(405); // prettier-ignore
    await cms.close();
  });

  test("is listed with the other routes", async () => {
    const { cms } = await setup();
    const paths = cms.inspect().routes.map((route) => `${route.method} ${route.path}`); // prettier-ignore
    expect(paths).toContain("GET /media/:id/:file");
    expect(paths).toContain("GET /media/:id/:variant/:file");
    expect(paths).toContain("GET /api/heyo-cms/media/:id/:variant");
    await cms.close();
  });
});

describe("rich text with library images", () => {
  const body = (id: string, alt = ""): JsonObject => ({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Before." }] },
      { type: "image", attrs: { src: "blob:pasted", alt, mediaId: id } },
    ] as JsonValue[],
  });

  test("cms.media.renderRichText gives every image a size, a srcset and lazy loading", async () => {
    const { cms, upload } = await setup();
    const file = await upload();
    const html = await cms.media.renderRichText(body(file.id), {
      locale: "pl",
      sizes: "100vw",
    });
    expect(html).toContain(`src="/media/${file.id}/lodz-report.webp"`);
    expect(html).toContain('alt="Raport"');
    expect(html).toContain('width="1200" height="800"');
    expect(html).toContain(`srcset="/media/${file.id}/small/lodz-report.webp 480w,`); // prettier-ignore
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain('loading="lazy" decoding="async"');

    // The editor's own alt text wins over the library's.
    const own = await cms.media.renderRichText(body(file.id, "Mine"));
    expect(own).toContain('alt="Mine"');
    expect(
      await cms.media.renderRichText(body(file.id), { format: "markdown" }),
    ).toContain(
      // prettier-ignore
      `![A report](/media/${file.id}/lodz-report.webp)`,
    );
    // The plain serialiser is unchanged for a caller that passes nothing.
    expect(richTextToHtml(body(file.id))).toBe(
      '<p>Before.</p><img src="blob:pasted" alt="" data-media-id="' + file.id + '">', // prettier-ignore
    );
    await cms.close();
  });

  test("?richText=html on the API resolves them the same way", async () => {
    const { cms, upload } = await setup();
    const file = await upload();
    const post = await cms.api.posts.create({
      data: { title: "Hello", cover: file.id, body: body(file.id) },
      actor,
    });
    const response = await get(cms, `/api/heyo-cms/posts/${post!.id}?richText=html`); // prettier-ignore
    const document = (await response.json()) as { body: string };
    expect(document.body).toContain('width="1200"');
    expect(document.body).toContain("srcset=");
    await cms.close();
  });

  test("cms.media.forDocuments lists what each document shows, per locale", async () => {
    const { cms, upload } = await setup();
    const cover = await upload(1200, 800, "cover.png");
    const inline = await upload(800, 600, "inline.png");
    const post = await cms.api.posts.create({
      data: { title: "Hello", cover: cover.id, body: body(inline.id) },
      actor,
    });
    await cms.api.posts.create({ data: { title: "Empty" }, actor });

    const usages = await cms.media.forDocuments("posts");
    expect([...usages.keys()]).toEqual([String(post!.id)]);
    const list = usages.get(String(post!.id))!;
    expect(
      list.map((entry) => [entry.media.id, entry.field, entry.locale]).sort(),
    ).toEqual(
      [
        [cover.id, "cover", null],
        [inline.id, "body", "en"],
      ].sort(),
    );
    expect(list[0]?.media.url).toStartWith("/media/");
    const only = await cms.media.forDocuments("posts", { ids: ["doc_nothing"] }); // prettier-ignore
    expect(only.size).toBe(0);
    await expect(cms.media.forDocuments("pages")).rejects.toThrow(/No collection/); // prettier-ignore

    const many = await cms.media.getMany([cover.id, "med_missing", inline.id]);
    expect([...many.keys()].sort()).toEqual([cover.id, inline.id].sort());
    await cms.close();
  });
});

describe("plugins: root routes, events and waitUntil", () => {
  test("a root route answers outside basePath; an event listener runs after the commit", async () => {
    const seen: CmsEvent[] = [];
    const plugin: CmsPlugin<unknown> = {
      id: "verify",
      routes: [
        {
          method: "GET",
          path: "/:file",
          root: true,
          handler: ({ params }) =>
            params.file === "token.txt"
              ? new Response("token")
              : new Response("Not found", { status: 404 }),
        },
      ],
      events: {
        "document.created": (event) => {
          seen.push(event);
        },
      },
    };
    const { cms } = await setup({ plugins: [plugin] });

    const file = await get(cms, "/token.txt");
    expect(await file.text()).toBe("token");
    expect((await get(cms, "/other.txt")).status).toBe(404);
    // Paths with more segments are not the plugin's, and say so as before.
    const outside = await get(cms, "/somewhere/else");
    expect(((await outside.json()) as { error: { code: string } }).error.code).toBe("outside_base_path"); // prettier-ignore

    // The write is delivered by the adapter's waitUntil, not left behind.
    const waited: Promise<unknown>[] = [];
    const route = astroHandler(cms);
    const response = await route.POST({
      request: new Request("https://site.test/api/heyo-cms/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { title: "Hello" } }),
      }),
      locals: { cfContext: { waitUntil: (p: Promise<unknown>) => waited.push(p) } }, // prettier-ignore
    });
    expect(response.status).toBe(201);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(seen.map((event) => event.type)).toEqual(["document.created"]);

    // A read hands nothing to waitUntil.
    await route.GET({
      request: new Request("https://site.test/api/heyo-cms/posts"),
      locals: { cfContext: { waitUntil: (p: Promise<unknown>) => waited.push(p) } }, // prettier-ignore
    });
    expect(waited).toHaveLength(1);
    await cms.close();
  });
});
