import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms, systemActor } from "../src/config";
import { mongodb } from "../src/db/mongodb";
import { postgres, type PostgresClient } from "../src/db/postgres";
import { sqlite } from "../src/db/sqlite";
import { json, media, richText, text } from "../src/fields";
import { probeImage } from "../src/media/probe";
import { stripImageMetadata } from "../src/media/strip";
import { eq } from "../src/query";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import type { Actor } from "../src/types/actor";
import type { HeyoCmsConfig, UploadsConfig } from "../src/types/config";
import type { JsonObject } from "../src/types/json";
import type { DatabaseAdapter } from "../src/types/database";
import type { CmsEvent } from "../src/types/events";
import type { CmsInstance } from "../src/types/instance";
import type {
  ImageProcessor,
  ImageTransform,
  MediaDocument,
} from "../src/types/media";
import type { StorageAdapter } from "../src/types/storage";
import {
  gifFixture,
  jpegFixture,
  pdfFixture,
  pngFixture,
  svgFixture,
  webpFixture,
} from "./images";
import { memoryMongo } from "./mongo-memory";

/**
 * Stage 6: media.
 *
 * The bet this suite settles is the one in section 6: that a file should never
 * be destroyed by an edit. Removing a picture from an article marks it unused
 * and nothing else; it keeps serving from the same URL; putting it back takes
 * it off the list; and only a sweep running after a deadline that has actually
 * passed, having checked the references one more time, deletes anything.
 *
 * It runs on all three engines because the accounting is a transaction around
 * three tables and a bucket, and because `media-gc` filters on "has a deadline
 * and it is in the past" — the one query shape where MongoDB's comparison of
 * a missing field against a date would hand the collector the whole library.
 */

const day = 86_400_000;

const collections = () => ({
  posts: defineCollection({
    fields: {
      title: text({ required: true }),
      cover: media({ accept: "image/*" }),
      gallery: media({ localized: true }),
      body: richText({ localized: true }),
      notes: json({}),
    },
  }),
  pages: defineCollection({
    fields: {
      title: text({ required: true }),
      hero: media({}),
    },
  }),
});

type Fixture = ReturnType<typeof collections>;
type Overrides = Partial<
  Omit<
    HeyoCmsConfig<Fixture, Record<string, never>>,
    "database" | "collections" | "uploads"
  >
>;

/**
 * The uploads section, assembled around a storage adapter the suite owns.
 *
 * Spelled out this way because every test needs a handle on the bucket — "is
 * the file still there" is the question this whole stage exists to answer —
 * and a configuration that built its own adapter would hide it.
 */
interface SetupOptions extends Overrides {
  images?: UploadsConfig["images"];
  retention?: UploadsConfig["retention"];
  limits?: UploadsConfig["limits"];
}

interface EngineUnderTest {
  name: string;
  create(): Promise<DatabaseAdapter> | DatabaseAdapter;
}

/**
 * A processor that renders nothing and records everything.
 *
 * The point of the variant pipeline is which transform is asked for, where
 * the result is written and whether the second request renders again — none of
 * which needs a codec. Depending on `sharp` to find out would make this suite
 * untestable on the runtimes the package exists to support.
 */
function fakeProcessor(): ImageProcessor & { calls: ImageTransform[] } {
  const calls: ImageTransform[] = [];
  return {
    id: "fake",
    calls,
    supports: (contentType) => contentType.startsWith("image/") && contentType !== "image/svg+xml", // prettier-ignore
    async transform(source, transform, info) {
      calls.push(transform);
      const width = transform.width ?? info.width;
      const height = transform.height ?? info.height;
      const contentType = transform.format ? `image/${transform.format}` : info.contentType; // prettier-ignore
      return {
        data: new TextEncoder().encode(
          JSON.stringify({ width, height, from: source.byteLength }),
        ),
        contentType,
        width,
        height,
      };
    },
  };
}

function runMediaSuite(entry: EngineUnderTest): void {
  describe(`media: ${entry.name}`, () => {
    const setup = async (
      options: SetupOptions = {},
    ): Promise<{
      cms: CmsInstance<Fixture, Record<string, never>>;
      adapter: DatabaseAdapter;
      storage: StorageAdapter;
      events: CmsEvent[];
      exists: (key: string) => Promise<boolean>;
    }> => {
      const adapter = await entry.create();
      const storage = memory({ baseUrl: "https://cdn.test/media" });
      const { images, retention, limits, ...overrides } = options;
      const cms = heyoCms({
        ...overrides,
        uploads: {
          storage,
          ...(images === undefined ? {} : { images }),
          ...(retention === undefined ? {} : { retention }),
          ...(limits === undefined ? {} : { limits }),
        },
        database: () => adapter,
        collections: collections(),
      });
      adapter.useSchema(cms.schema);
      await adapter.applyMigration(
        adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_media"),
      );

      const events: CmsEvent[] = [];
      cms.on("*", (event) => {
        events.push(event);
      });

      return {
        cms,
        adapter,
        storage,
        events,
        exists: async (key) => (await storage.head?.(key)) !== null,
      };
    };

    const actor: Actor = systemActor("usr_test");
    const upload = (
      cms: CmsInstance<Fixture, Record<string, never>>,
      options: { name?: string; width?: number; height?: number } = {},
    ): Promise<MediaDocument> =>
      cms.media.upload({
        file: pngFixture(options.width ?? 1200, options.height ?? 800),
        filename: options.name ?? "photo.png",
        contentType: "image/png",
        alt: "A photograph",
        actor,
      });

    // -----------------------------------------------------------------------
    // Upload
    // -----------------------------------------------------------------------

    test("an upload stores the bytes, reads the dimensions and records the file", async () => {
      const { cms, storage, events, exists } = await setup();

      const file = await upload(cms, { width: 1200, height: 800 });
      expect(file.id).toStartWith("med_");
      expect(file.filename).toBe("photo.png");
      expect(file.mimeType).toBe("image/png");
      // Read from the header, with no codec and on every runtime.
      expect(file.width).toBe(1200);
      expect(file.height).toBe(800);
      expect(file.status).toBe("active");
      expect(file.alt).toEqual({ en: "A photograph" });
      expect(file.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(file.createdBy).toBe("usr_test");

      // The key carries the id and never changes, which is what lets the
      // object be cached forever.
      expect(file.storageKey).toContain(file.id);
      expect(file.storageKey).toEndWith(".png");
      expect(await exists(file.storageKey)).toBe(true);
      expect(file.url).toBe(storage.url(file.storageKey));

      await cms.drainEvents();
      const event = events.find((entry) => entry.type === "media.uploaded");
      expect((event?.data.media as unknown as MediaDocument).id).toBe(file.id);
      await cms.close();
    });

    test("the bytes decide the type, not the label on them", async () => {
      const { cms } = await setup();
      const file = await cms.media.upload({
        file: jpegFixture(640, 480),
        filename: "screenshot.png",
        // A browser sends this for anything it does not recognise, and a
        // caller can send whatever it likes.
        contentType: "application/octet-stream",
      });
      expect(file.mimeType).toBe("image/jpeg");
      expect(file.width).toBe(640);
      expect(file.storageKey).toEndWith(".jpg");
      await cms.close();
    });

    test("limits are enforced before anything reaches storage", async () => {
      const { cms } = await setup({
        limits: {
          maxFileSize: "1kb",
          maxImageDimensions: { width: 2000, height: 2000 },
          accept: ["image/*", "application/pdf"],
        },
      });

      await expect(
        cms.media.upload({
          file: new Uint8Array(4096),
          filename: "big.bin",
          contentType: "application/octet-stream",
        }),
      ).rejects.toThrow(/not an accepted file type/);

      await expect(
        cms.media.upload({
          file: pngFixture(5000, 5000),
          filename: "huge.png",
          contentType: "image/png",
        }),
      ).rejects.toThrow(/over the 2000x2000 limit/);

      await expect(
        cms.media.upload({
          file: pdfFixture(),
          filename: "doc.pdf",
          contentType: "application/pdf",
          // A PDF is accepted by type and refused by size, which proves the
          // two checks are independent.
          metadata: {},
        }),
      ).resolves.toBeDefined();

      expect((await cms.media.list()).docs).toHaveLength(1);
      await cms.close();
    });

    test("stripping metadata happens with or without a processor", async () => {
      const { cms, storage } = await setup({
        images: { stripMetadata: true },
      });

      const withExif = jpegFixture(100, 100, { exif: "GPS 52.2297 21.0122" });
      const file = await cms.media.upload({
        file: withExif,
        filename: "holiday.jpg",
        contentType: "image/jpeg",
      });

      const stored = await readAll(await storage.get(file.storageKey));
      const text_ = new TextDecoder().decode(stored);
      // Publishing somebody's home address alongside their photograph is a
      // privacy failure, not a missing optimisation (section 6).
      expect(text_).not.toContain("GPS 52.2297");
      expect(text_).toContain("JFIF");
      // Still a JPEG, and still the same picture.
      expect(probeImage(stored)?.width).toBe(100);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // The lifecycle
    // -----------------------------------------------------------------------

    test("removing a picture from an article does not delete the file", async () => {
      const { cms, events, exists } = await setup();
      const file = await upload(cms);

      const post = await cms.api.posts.create({
        data: { title: "Illustrated", cover: file.id },
        actor,
      });
      const id = String(post?.id);
      expect(await cms.media.usages(file.id)).toHaveLength(1);

      await cms.api.posts.update({ id, data: { cover: null }, actor });

      const orphan = await cms.media.get(file.id);
      expect(orphan?.status).toBe("orphaned");
      expect(orphan?.orphanedAt).not.toBeNull();
      // Thirty days by default, and the file says so itself.
      expect(orphan?.purgeAfter).not.toBeNull();
      // Still there, still serving from exactly the same URL.
      expect(await exists(file.storageKey)).toBe(true);
      expect(await cms.media.usages(file.id)).toHaveLength(0);

      await cms.drainEvents();
      const event = events.find((entry) => entry.type === "media.orphaned");
      expect(event?.data.mediaId).toBe(file.id);
      expect(event?.data.documentId).toBe(id);
      await cms.close();
    });

    test("using it again within the window brings it back", async () => {
      const { cms, events } = await setup();
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Back", cover: file.id },
      });
      const id = String(post?.id);

      await cms.api.posts.update({ id, data: { cover: null } });
      expect((await cms.media.get(file.id))?.status).toBe("orphaned");

      await cms.api.posts.update({ id, data: { cover: file.id } });
      const reclaimed = await cms.media.get(file.id);
      expect(reclaimed?.status).toBe("active");
      expect(reclaimed?.orphanedAt).toBeNull();
      expect(reclaimed?.purgeAfter).toBeNull();

      await cms.drainEvents();
      expect(events.map((entry) => entry.type)).toContain("media.reclaimed");
      await cms.close();
    });

    test("the collector deletes the file and the record once the deadline passes", async () => {
      const { cms, adapter, events, exists } = await setup();
      const expired = await upload(cms, { name: "old.png" });
      const fresh = await upload(cms, { name: "new.png" });

      const post = await cms.api.posts.create({
        data: { title: "Both", cover: expired.id, gallery: fresh.id },
      });
      await cms.api.posts.update({
        id: String(post?.id),
        data: { cover: null, gallery: null },
      });

      // Backdated rather than waited out: thirty days is the point of the
      // feature and a bad length for a test.
      await backdate(adapter, expired.id, new Date(Date.now() - day));

      const report = await cms.media.collect();
      expect(report).toEqual({ examined: 1, purged: 1, reclaimed: 0, failed: 0 }); // prettier-ignore

      expect(await cms.media.get(expired.id)).toBeNull();
      expect(await exists(expired.storageKey)).toBe(false);
      // The one whose deadline has not arrived is untouched.
      expect((await cms.media.get(fresh.id))?.status).toBe("orphaned");
      expect(await exists(fresh.storageKey)).toBe(true);

      await cms.drainEvents();
      const purged = events.find(
        (entry) => entry.type === "media.purged" && entry.data.collected === true, // prettier-ignore
      );
      expect((purged?.data.media as unknown as MediaDocument).id).toBe(
        expired.id,
      );
      await cms.close();
    });

    test("the deadline is necessary and never sufficient", async () => {
      const { cms, adapter, exists } = await setup();
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Used", cover: file.id },
      });
      await cms.api.posts.update({ id: String(post?.id), data: { cover: null } }); // prettier-ignore
      await backdate(adapter, file.id, new Date(Date.now() - day));

      // Used again after the deadline passed but before the sweep ran: thirty
      // days is long enough for that to happen, so the collector checks the
      // references one more time rather than trusting the column.
      await cms.api.posts.update({
        id: String(post?.id),
        data: { cover: file.id },
      });
      // The reclaim already cleared the deadline, so force the race: put the
      // row back the way a collector that read it a moment too early saw it.
      await restoreOrphanState(adapter, file.id, new Date(Date.now() - day));

      const report = await cms.media.collect();
      expect(report.purged).toBe(0);
      expect(report.reclaimed).toBe(1);
      expect((await cms.media.get(file.id))?.status).toBe("active");
      expect(await exists(file.storageKey)).toBe(true);
      await cms.close();
    });

    test('"Keep" clears the deadline and leaves the file alone forever', async () => {
      const { cms, adapter } = await setup();
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Keep", cover: file.id },
      });
      await cms.api.posts.update({ id: String(post?.id), data: { cover: null } }); // prettier-ignore

      const kept = await cms.media.keep({ id: file.id, actor });
      expect(kept.purgeAfter).toBeNull();
      // Still unused, because it is: the button clears a deadline, it does not
      // invent a reference.
      expect(kept.status).toBe("orphaned");

      await backdate(adapter, file.id, null);
      expect((await cms.media.collect()).examined).toBe(0);
      expect(await cms.media.get(file.id)).not.toBeNull();

      await expect(
        cms.media.keep({ id: (await upload(cms, { name: "live.png" })).id }),
      ).rejects.toThrow(/only an unused file/);
      await cms.close();
    });

    test("purgeAfter: false keeps unused files forever", async () => {
      const { cms, adapter } = await setup({
        retention: { purgeAfter: false },
      });
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Forever", cover: file.id },
      });
      await cms.api.posts.update({ id: String(post?.id), data: { cover: null } }); // prettier-ignore

      const orphan = await cms.media.get(file.id);
      expect(orphan?.status).toBe("orphaned");
      expect(orphan?.purgeAfter).toBeNull();

      await backdate(adapter, file.id, new Date(Date.now() - day));
      expect((await cms.media.collect()).examined).toBe(0);
      expect(await cms.media.get(file.id)).not.toBeNull();
      await cms.close();
    });

    test("references are counted per locale and inside rich text", async () => {
      const { cms } = await setup();
      const inline = await upload(cms, { name: "inline.png" });
      const german = await upload(cms, { name: "german.png" });

      const post = await cms.api.posts.create({
        data: {
          title: "Translated",
          body: document_(inline.id),
        },
        locale: "en",
      });
      const id = String(post?.id);
      await cms.api.posts.update({
        id,
        data: { gallery: german.id },
        locale: "de",
      });

      const inlineUsage = await cms.media.usages(inline.id);
      expect(inlineUsage).toHaveLength(1);
      expect(inlineUsage[0]?.field).toBe("body");
      expect(inlineUsage[0]?.locale).toBe("en");

      const germanUsage = await cms.media.usages(german.id);
      expect(germanUsage[0]?.locale).toBe("de");

      // Dropping the German gallery must not touch the English article, which
      // is why the count is kept per locale rather than per document.
      await cms.api.posts.update({ id, data: { gallery: null }, locale: "de" });
      expect((await cms.media.get(german.id))?.status).toBe("orphaned");
      expect((await cms.media.get(inline.id))?.status).toBe("active");

      await cms.api.posts.update({ id, data: { body: document_(null) }, locale: "en" }); // prettier-ignore
      expect((await cms.media.get(inline.id))?.status).toBe("orphaned");
      await cms.close();
    });

    test("a file used twice survives losing one of its uses", async () => {
      const { cms } = await setup();
      const file = await upload(cms);
      const first = await cms.api.posts.create({
        data: { title: "One", cover: file.id },
      });
      const second = await cms.api.pages.create({
        data: { title: "Two", hero: file.id },
      });
      expect(await cms.media.usages(file.id)).toHaveLength(2);

      await cms.api.posts.update({ id: String(first?.id), data: { cover: null } }); // prettier-ignore
      expect((await cms.media.get(file.id))?.status).toBe("active");

      await cms.api.pages.update({ id: String(second?.id), data: { hero: null } }); // prettier-ignore
      expect((await cms.media.get(file.id))?.status).toBe("orphaned");
      await cms.close();
    });

    test("the trash keeps references and a purge releases them", async () => {
      const { cms, exists } = await setup();
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Doomed", cover: file.id },
      });
      const id = String(post?.id);

      await cms.api.posts.delete({ id });
      // A picture used by a document an editor can still restore is not an
      // unused picture.
      expect(await cms.media.usages(file.id)).toHaveLength(1);
      expect((await cms.media.get(file.id))?.status).toBe("active");

      await cms.api.posts.purge({ id });
      expect(await cms.media.usages(file.id)).toHaveLength(0);
      expect((await cms.media.get(file.id))?.status).toBe("orphaned");
      // Orphaned, not gone: the deadline is what deletes files.
      expect(await exists(file.storageKey)).toBe(true);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // The library
    // -----------------------------------------------------------------------

    test("deleting a file in use is refused, and naming what uses it", async () => {
      const { cms, exists } = await setup();
      const file = await upload(cms);
      await cms.api.posts.create({ data: { title: "Front page", cover: file.id } }); // prettier-ignore

      await expect(cms.media.delete({ id: file.id, actor })).rejects.toThrow(
        /is used by 1 document/,
      );
      expect(await exists(file.storageKey)).toBe(true);

      const deleted = await cms.media.delete({ id: file.id, force: true, actor }); // prettier-ignore
      expect(deleted.id).toBe(file.id);
      expect(await cms.media.get(file.id)).toBeNull();
      expect(await exists(file.storageKey)).toBe(false);
      expect(await cms.media.usages(file.id)).toHaveLength(0);
      await cms.close();
    });

    test("the library lists, filters and pages", async () => {
      const { cms } = await setup();
      for (let index = 0; index < 5; index += 1) {
        await cms.media.upload({
          file: pngFixture(100 + index, 100),
          filename: `photo-${index}.png`,
          contentType: "image/png",
        });
      }
      await cms.media.upload({
        file: pdfFixture(),
        filename: "report.pdf",
        contentType: "application/pdf",
      });

      expect((await cms.media.list()).docs).toHaveLength(6);
      expect((await cms.media.list({ mimeType: "image/*" })).docs).toHaveLength(5); // prettier-ignore
      expect(
        (await cms.media.list({ mimeType: "application/pdf" })).docs,
      ).toHaveLength(1);
      expect((await cms.media.list({ search: "photo-3" })).docs).toHaveLength(
        1,
      );

      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const result: Awaited<ReturnType<typeof cms.media.list>> =
          await cms.media.list({
            limit: 2,
            ...(cursor === null ? {} : { cursor }),
          });
        for (const file of result.docs) seen.add(file.id);
        cursor = result.cursor;
        if (!result.hasNextPage) break;
      }
      expect(seen.size).toBe(6);
      await cms.close();
    });

    test("alt text is localized and metadata keeps its reserved keys", async () => {
      const { cms } = await setup({
        images: { focalPoint: true, crop: true },
      });
      const file = await upload(cms);

      const named = await cms.media.update({
        id: file.id,
        alt: "Ein Foto",
        locale: "de",
        metadata: { credit: "Jan Kowalski" },
        actor,
      });
      expect(named.alt).toEqual({ en: "A photograph", de: "Ein Foto" });
      expect(named.metadata).toEqual({ credit: "Jan Kowalski" });

      const focused = await cms.media.update({
        id: file.id,
        focalPoint: { x: 0.25, y: 0.75 },
        crop: { x: 10, y: 20, width: 400, height: 300 },
        actor,
      });
      expect(focused.focalPoint).toEqual({ x: 0.25, y: 0.75 });
      expect(focused.crop).toEqual({ x: 10, y: 20, width: 400, height: 300 });
      // The two engine-owned keys do not leak into user metadata.
      expect(focused.metadata).toEqual({ credit: "Jan Kowalski" });

      await expect(
        cms.media.update({ id: file.id, metadata: { crop: "mine" } }),
      ).rejects.toThrow(/reserved/);
      await expect(
        cms.media.update({ id: file.id, focalPoint: { x: 4, y: 0 } }),
      ).rejects.toThrow(/between 0 and 1/);
      await cms.close();
    });

    test("focal points and crops are refused when they are switched off", async () => {
      const { cms } = await setup();
      const file = await upload(cms);
      await expect(
        cms.media.update({ id: file.id, focalPoint: { x: 0.5, y: 0.5 } }),
      ).rejects.toThrow(/uploads.images.focalPoint/);
      await expect(
        cms.media.update({ id: file.id, crop: { x: 0, y: 0, width: 1, height: 1 } }), // prettier-ignore
      ).rejects.toThrow(/uploads.images.crop/);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Variants
    // -----------------------------------------------------------------------

    test("an on-demand variant is rendered once and stored", async () => {
      const processor = fakeProcessor();
      const { cms, exists } = await setup({
        images: {
          processor,
          quality: 82,
          convert: { to: "webp" },
          variants: {
            mode: "on-demand",
            sizes: { thumb: { width: 320, height: 320, fit: "cover" } },
          },
        },
      });

      const file = await upload(cms);
      // `convert` already used the processor once, on the way in: the stored
      // original is a WebP and every size is rendered from it.
      expect(processor.calls).toHaveLength(1);
      expect(file.mimeType).toBe("image/webp");

      const first = await cms.media.variant({ id: file.id, variant: "thumb" });
      expect(first?.cached).toBe(false);
      expect(first?.width).toBe(320);
      expect(first?.contentType).toBe("image/webp");
      expect(first?.key).toEndWith("/thumb.webp");
      expect(await exists(first?.key ?? "")).toBe(true);
      await drain(first?.body);

      const second = await cms.media.variant({ id: file.id, variant: "thumb" });
      // The second request is a storage hit. That is the whole difference
      // between on-demand variants and resizing on every request.
      expect(second?.cached).toBe(true);
      expect(processor.calls).toHaveLength(2);
      await drain(second?.body);

      const again = await cms.media.variant({
        id: file.id,
        variant: "thumb",
        refresh: true,
      });
      expect(processor.calls).toHaveLength(3);
      await drain(again?.body);

      expect((await cms.media.get(file.id))?.variants).toEqual(["thumb"]);
      await expect(
        cms.media.variant({ id: file.id, variant: "nope" }),
      ).rejects.toThrow(/No image size named "nope"/);
      await cms.close();
    });

    test("the focal point and the crop reach the renderer", async () => {
      const processor = fakeProcessor();
      const { cms } = await setup({
        images: {
          processor,
          focalPoint: true,
          crop: true,
          variants: {
            mode: "on-demand",
            sizes: { card: { width: 768, height: 512, fit: "cover" } },
          },
        },
      });

      const file = await upload(cms);
      await cms.media.update({
        id: file.id,
        focalPoint: { x: 0.2, y: 0.8 },
        crop: { x: 100, y: 50, width: 900, height: 600 },
      });

      await drain(
        (await cms.media.variant({ id: file.id, variant: "card" }))?.body,
      );
      const call = processor.calls[0];
      expect(call?.position).toEqual({ x: 0.2, y: 0.8 });
      expect(call?.crop).toEqual({ x: 100, y: 50, width: 900, height: 600 });
      await cms.close();
    });

    test("changing the crop discards the sizes rendered from the old one", async () => {
      const processor = fakeProcessor();
      const { cms, exists } = await setup({
        images: {
          processor,
          crop: true,
          variants: { mode: "on-demand", sizes: { thumb: { width: 320 } } },
        },
      });

      const file = await upload(cms);
      const rendered = await cms.media.variant({ id: file.id, variant: "thumb" }); // prettier-ignore
      await drain(rendered?.body);
      expect(await exists(rendered?.key ?? "")).toBe(true);

      await cms.media.update({
        id: file.id,
        crop: { x: 0, y: 0, width: 100, height: 100 },
      });
      // Leaving them would serve a thumbnail of the wrong part of the picture
      // until somebody happened to notice.
      expect(await exists(rendered?.key ?? "")).toBe(false);
      expect((await cms.media.get(file.id))?.variants).toEqual([]);
      await cms.close();
    });

    test("pregenerate renders every size at upload time", async () => {
      const processor = fakeProcessor();
      const { cms } = await setup({
        images: {
          processor,
          variants: {
            mode: "pregenerate",
            sizes: { thumb: { width: 320 }, hero: { width: 1920 } },
          },
        },
      });

      const file = await upload(cms);
      expect(processor.calls).toHaveLength(2);
      expect(file.variants).toEqual(["hero", "thumb"]);

      const cached = await cms.media.variant({ id: file.id, variant: "thumb" });
      expect(cached?.cached).toBe(true);
      await drain(cached?.body);
      await cms.close();
    });

    test("without a processor the original is served and the URL carries the size", async () => {
      const { cms } = await setup({
        images: {
          quality: 70,
          variants: {
            mode: "on-demand",
            sizes: { hero: { width: 1920, height: 600, fit: "cover" } },
          },
        },
      });

      const file = await upload(cms);
      const result = await cms.media.variant({ id: file.id, variant: "hero" });
      // A legitimate deployment rather than a misconfiguration: this is the
      // arrangement where an image CDN does the resizing at the edge.
      expect(result?.key).toBe(file.storageKey);
      expect(result?.cached).toBe(false);
      expect(result?.url).toContain("w=1920");
      expect(result?.url).toContain("h=600");
      expect(result?.url).toContain("fit=cover");
      expect(result?.url).toContain("q=70");
      await drain(result?.body);
      await cms.close();
    });

    test("the original is served for a file nothing can resize", async () => {
      const processor = fakeProcessor();
      const { cms } = await setup({
        images: {
          processor,
          variants: { mode: "on-demand", sizes: { thumb: { width: 320 } } },
        },
      });

      const file = await cms.media.upload({
        file: svgFixture(512, 512),
        filename: "logo.svg",
        contentType: "image/svg+xml",
      });
      expect(file.width).toBe(512);

      const result = await cms.media.variant({ id: file.id, variant: "thumb" });
      // An SVG already scales; rasterising one to make a thumbnail would be a
      // downgrade, not a feature.
      expect(result?.key).toBe(file.storageKey);
      expect(processor.calls).toHaveLength(0);
      await drain(result?.body);
      await cms.close();
    });

    // -----------------------------------------------------------------------
    // Jobs, access and inspection
    // -----------------------------------------------------------------------

    test("media-gc runs with the other sweeps", async () => {
      const { cms, adapter, exists } = await setup();
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Swept", cover: file.id },
      });
      await cms.api.posts.update({ id: String(post?.id), data: { cover: null } }); // prettier-ignore
      await backdate(adapter, file.id, new Date(Date.now() - day));

      expect(cms.inspect().jobs).toEqual([
        "scheduled-changes",
        "trash-purge",
        "media-gc",
      ]);

      const report = await cms.jobs.run();
      expect(
        report.results.find((result) => result.job === "media-gc")?.processed,
      ).toBe(1);
      expect(await cms.media.get(file.id)).toBeNull();
      expect(await exists(file.storageKey)).toBe(false);
      await cms.close();
    });

    test("a bucket that refuses a delete records why and backs off", async () => {
      const { cms, adapter, storage } = await setup();
      const file = await upload(cms);
      const post = await cms.api.posts.create({
        data: { title: "Stuck", cover: file.id },
      });
      await cms.api.posts.update({ id: String(post?.id), data: { cover: null } }); // prettier-ignore
      await backdate(adapter, file.id, new Date(Date.now() - day));

      const original = storage.delete.bind(storage);
      storage.delete = async () => {
        throw new Error("AccessDenied");
      };
      const report = await cms.media.collect();
      storage.delete = original;

      expect(report.failed).toBe(1);
      const stuck = await cms.media.get(file.id);
      // Back to orphaned rather than stranded in `purging`, with the reason
      // on the record and the deadline pushed out so the sweep does not
      // hammer a bucket that is already refusing.
      expect(stuck?.status).toBe("orphaned");
      expect(stuck?.purgeError).toContain("AccessDenied");
      expect(new Date(String(stuck?.purgeAfter)).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect((await cms.media.collect()).examined).toBe(0);
      await cms.close();
    });

    test("writing to the library needs a permission, reading does not", async () => {
      const { cms } = await setup({
        rbac: { roles: { admin: ["*"], writer: ["posts:*"] } },
      });

      const writer: Actor = {
        id: "usr_writer",
        source: "session",
        roles: ["writer"],
        permissions: ["posts:read", "posts:create", "posts:update"],
      };

      await expect(
        cms.media.upload({
          file: pngFixture(10, 10),
          filename: "a.png",
          contentType: "image/png",
          actor: writer,
        }),
      ).rejects.toThrow(/media:create/);

      const file = await upload(cms);
      await expect(
        cms.media.delete({ id: file.id, actor: writer }),
      ).rejects.toThrow(/media:delete/);

      // Reads are open: a file's URL is public the moment it is on a page, so
      // gating this would break anonymous rendering and protect nothing.
      expect((await cms.media.get(file.id))?.id).toBe(file.id);
      expect((await cms.media.list()).docs).toHaveLength(1);
      await cms.close();
    });

    test("inspect prints what happens to a file", async () => {
      const { cms } = await setup({
        retention: { purgeAfter: "7d" },
        images: {
          processor: fakeProcessor(),
          variants: { mode: "on-demand", sizes: { thumb: { width: 320 } } },
        },
      });

      expect(cms.inspect().storage).toEqual({
        id: "memory",
        variants: "on-demand",
        processor: "fake",
        purgeAfter: "7d",
      });
      await cms.close();
    });
  });
}

// ---------------------------------------------------------------------------
// Engine-independent behaviour
// ---------------------------------------------------------------------------

describe("image headers", () => {
  test("dimensions are read from every format the panel accepts", () => {
    expect(probeImage(pngFixture(1200, 800))).toMatchObject({
      format: "png",
      width: 1200,
      height: 800,
    });
    expect(probeImage(jpegFixture(640, 480))).toMatchObject({
      format: "jpeg",
      width: 640,
      height: 480,
    });
    expect(probeImage(gifFixture(16, 24))).toMatchObject({
      format: "gif",
      width: 16,
      height: 24,
    });
    expect(probeImage(webpFixture(2000, 1000))).toMatchObject({
      format: "webp",
      width: 2000,
      height: 1000,
    });
    expect(probeImage(svgFixture(64, 64))).toMatchObject({
      format: "svg",
      width: 64,
      height: 64,
    });
  });

  test("anything that is not an image reads as one", () => {
    expect(probeImage(pdfFixture())).toBeNull();
    expect(probeImage(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(probeImage(new Uint8Array(0))).toBeNull();
  });

  test("a JPEG loses EXIF and keeps its structure", () => {
    const stripped = stripImageMetadata(
      jpegFixture(100, 100, { exif: "GPS 52.2297 21.0122" }),
      "image/jpeg",
    );
    const text_ = new TextDecoder().decode(stripped);
    expect(text_).not.toContain("GPS");
    expect(text_).toContain("JFIF");
    expect(probeImage(stripped)?.height).toBe(100);
  });

  test("a PNG loses its text chunks and stays readable", () => {
    const stripped = stripImageMetadata(
      pngFixture(32, 48, { text: "taken in Warsaw" }),
      "image/png",
    );
    expect(new TextDecoder().decode(stripped)).not.toContain("Warsaw");
    expect(probeImage(stripped)).toMatchObject({ width: 32, height: 48 });
  });

  test("a WebP loses its EXIF chunk and its RIFF size is corrected", () => {
    const original = webpFixture(400, 300, { exif: true });
    const stripped = stripImageMetadata(original, "image/webp");
    expect(stripped.byteLength).toBeLessThan(original.byteLength);
    expect(new TextDecoder().decode(stripped)).not.toContain("exif-payload");
    expect(probeImage(stripped)).toMatchObject({ width: 400, height: 300 });

    // The declared size has to match the bytes that follow it, or a decoder
    // reads past the end of the file.
    const declared = new DataView(stripped.buffer, stripped.byteOffset).getUint32(4, true); // prettier-ignore
    expect(declared).toBe(stripped.byteLength - 8);
  });

  test("a format we do not understand is returned untouched", () => {
    const pdf = pdfFixture();
    expect(stripImageMetadata(pdf, "application/pdf")).toBe(pdf);
  });
});

describe("media configuration", () => {
  const database = (): DatabaseAdapter => sqlite(new Database(":memory:"));
  const base = {
    collections: {
      posts: defineCollection({ fields: { title: text({ required: true }) } }),
    },
  };

  test("a transformation nothing can perform is refused while the module loads", () => {
    expect(() =>
      heyoCms({
        ...base,
        database,
        uploads: { storage: memory(), images: { convert: { to: "webp" } } },
      }),
    ).toThrow(/uploads.images.processor/);

    expect(() =>
      heyoCms({
        ...base,
        database,
        uploads: {
          storage: memory(),
          images: {
            variants: { mode: "pregenerate", sizes: { thumb: { width: 10 } } },
          },
        },
      }),
    ).toThrow(/pregenerate/);

    // On-demand without a processor is a real deployment: the edge resizes.
    expect(() =>
      heyoCms({
        ...base,
        database,
        uploads: {
          storage: memory(),
          images: {
            variants: { mode: "on-demand", sizes: { thumb: { width: 10 } } },
          },
        },
      }),
    ).not.toThrow();
  });

  test("a size that cannot be rendered is refused", () => {
    const images = (
      sizes: Record<string, { width?: number; height?: number; fit?: "cover" }>,
    ) => ({
      // prettier-ignore
      storage: memory(),
      images: {
        processor: fakeProcessor(),
        variants: { mode: "on-demand" as const, sizes },
      },
    });

    expect(() =>
      heyoCms({ ...base, database, uploads: images({ thumb: {} }) }),
    ).toThrow(
      // prettier-ignore
      /needs a width, a height, or both/,
    );
    expect(() =>
      heyoCms({
        ...base,
        database,
        uploads: images({ thumb: { width: 320, fit: "cover" } }),
      }),
    ).toThrow(/needs both a width and a height/);
    expect(() =>
      heyoCms({
        ...base,
        database,
        uploads: images({ Thumb: { width: 320 } }),
      }),
    ).toThrow(/ends up in a URL/);
  });

  test("without uploads the media API explains itself once", async () => {
    const cms = heyoCms({ ...base, database });
    await expect(
      cms.media.upload({ file: new Uint8Array(1), filename: "a.bin" }),
    ).rejects.toThrow(/no uploads configured/);
    expect(cms.inspect().storage).toBeNull();
    expect(cms.inspect().jobs).not.toContain("media-gc");
    await cms.close();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A ProseMirror document with, or without, an inline image. */
function document_(mediaId: string | null): JsonObject {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      ...(mediaId === null
        ? []
        : [{ type: "image", attrs: { mediaId, alt: "inline" } }]),
    ],
  };
}

/** Backdates a purge deadline, so a thirty-day retention is testable. */
async function backdate(
  adapter: DatabaseAdapter,
  id: string,
  at: Date | null,
): Promise<void> {
  await adapter.transaction((tx) =>
    adapter.mutate(tx, {
      kind: "update",
      table: "media",
      where: eq("id", id),
      set: { purge_after: at },
      returning: false,
    }),
  );
}

/** Puts a reclaimed file back the way a collector saw it a moment too early. */
async function restoreOrphanState(
  adapter: DatabaseAdapter,
  id: string,
  at: Date,
): Promise<void> {
  await adapter.transaction((tx) =>
    adapter.mutate(tx, {
      kind: "update",
      table: "media",
      where: eq("id", id),
      set: { status: "orphaned", orphaned_at: at, purge_after: at },
      returning: false,
    }),
  );
}

async function readAll(stream: ReadableStream | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function drain(body: ReadableStream | undefined): Promise<void> {
  if (!body) return;
  await readAll(body);
}

runMediaSuite({
  name: "sqlite",
  create: () => sqlite(new Database(":memory:")),
});

runMediaSuite({
  name: "postgres (pglite)",
  create: () => {
    const database = new PGlite();
    const client: PostgresClient = {
      async query(text_, values) {
        const result = await database.query(text_, values as unknown[]);
        return {
          rows: result.rows as never[],
          rowCount: result.affectedRows ?? result.rows.length,
        };
      },
      async end() {
        await database.close();
      },
    };
    return postgres(client);
  },
});

runMediaSuite({
  name: "mongodb (in-process)",
  create: () => mongodb(memoryMongo(), { transactions: false }),
});
