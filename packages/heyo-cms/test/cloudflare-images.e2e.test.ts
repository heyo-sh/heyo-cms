import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";
import { media, text } from "../src/fields";
import { cloudflareImages } from "../src/media/cloudflare";
import { probeImage } from "../src/media/probe";
import { emptySnapshot } from "../src/schema/snapshot";
import { memory } from "../src/storage/local";
import type { CloudflareImagesBinding } from "../src/media/cloudflare";
import { pngFixture, svgFixture, webpFixture } from "./images";

/**
 * `cloudflareImages()` through the real upload and variant pipeline.
 *
 * Only the Images binding is emulated, and only as far as geometry goes: it
 * reads the size of its input, applies `trim`, `width`, `height` and `fit` the
 * way Cloudflare documents them, and emits a real WebP/PNG header of that
 * size. Everything above it — `convert`, `maxDimensions`, variants, focal
 * point, storage — is the production code, which is the point: this is the
 * path a Worker takes, minus workerd.
 */

function emulatedBinding(): CloudflareImagesBinding & { renders: number } {
  const state = { renders: 0 };
  const binding: CloudflareImagesBinding = {
    input(stream) {
      const options: Record<string, unknown>[] = [];
      const transformer = {
        transform(next: Record<string, unknown>) {
          options.push(next);
          return transformer;
        },
        async output(output: Record<string, unknown>) {
          state.renders++;
          const input = new Uint8Array(
            await new Response(stream).arrayBuffer(),
          );
          const probed = probeImage(input);
          if (!probed) throw new Error("emulator: unreadable input");
          let { width, height } = probed;

          for (const step of options) {
            const trim = step.trim as
              | { left: number; top: number; right: number; bottom: number }
              | undefined;
            if (trim) {
              width -= trim.left + trim.right;
              height -= trim.top + trim.bottom;
            }
            const w = step.width as number | undefined;
            const h = step.height as number | undefined;
            if (w !== undefined || h !== undefined) {
              if (step.fit === "cover" || step.fit === "pad") {
                width = w ?? width;
                height = h ?? height;
              } else {
                // scale-down: fit inside, never enlarge.
                const scale = Math.min(
                  w === undefined ? Infinity : w / width,
                  h === undefined ? Infinity : h / height,
                  1,
                );
                width = Math.round(width * scale);
                height = Math.round(height * scale);
              }
            }
          }

          const contentType = String(output.format);
          const bytes =
            contentType === "image/webp"
              ? webpFixture(width, height)
              : pngFixture(width, height);
          return {
            contentType: () => contentType,
            image: () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
          };
        },
      };
      return transformer;
    },
  };
  // `defineProperty`, not `Object.assign`: assign would read the getter once
  // and copy a number, and the counter would never move.
  return Object.defineProperty(binding, "renders", {
    get: () => state.renders,
  }) as CloudflareImagesBinding & { renders: number };
}

async function setup(binding: CloudflareImagesBinding) {
  const adapter = sqlite(new Database(":memory:"));
  const storage = memory({ baseUrl: "https://cdn.test/media" });
  const cms = heyoCms({
    database: () => adapter,
    collections: {
      posts: defineCollection({
        fields: { title: text({ required: true }), cover: media({}) },
      }),
    },
    uploads: {
      storage,
      limits: { maxImageDimensions: { width: 8000, height: 8000 } },
      images: {
        processor: cloudflareImages(() => binding),
        convert: { to: "webp", keep: ["image/gif", "image/svg+xml"] },
        quality: 82,
        maxDimensions: { width: 2000, height: 2000 },
        focalPoint: true,
        crop: true,
        variants: {
          mode: "on-demand",
          sizes: {
            thumb: { width: 320, height: 320, fit: "cover" },
            card: { width: 768 },
          },
        },
      },
    },
  });
  adapter.useSchema(cms.schema);
  await adapter.applyMigration(
    adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_cf"),
  );
  return { cms, storage };
}

async function bytesOf(body: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe("cloudflareImages through the media pipeline", () => {
  test("convert: webp and maxDimensions apply to the stored original", async () => {
    const binding = emulatedBinding();
    const { cms, storage } = await setup(binding);

    const file = await cms.media.upload({
      file: pngFixture(4000, 3000),
      filename: "photo.png",
      contentType: "image/png",
    });

    // 4000x3000 inside 2000x2000, as WebP: what `sharpImages()` would store.
    expect(file.mimeType).toBe("image/webp");
    expect(file.width).toBe(2000);
    expect(file.height).toBe(1500);
    expect(file.storageKey).toEndWith(".webp");

    const stored = await storage.get(file.storageKey);
    const probed = probeImage(await bytesOf(stored!));
    expect(probed).toMatchObject({ format: "webp", width: 2000, height: 1500 });
    await cms.close();
  });

  test("a small image is converted but not enlarged", async () => {
    const { cms } = await setup(emulatedBinding());
    const file = await cms.media.upload({
      file: pngFixture(400, 300),
      filename: "logo.png",
      contentType: "image/png",
    });
    expect(file.mimeType).toBe("image/webp");
    expect([file.width, file.height]).toEqual([400, 300]);
    await cms.close();
  });

  test("an SVG is left alone: the binding cannot decode one and convert keeps it", async () => {
    const binding = emulatedBinding();
    const { cms } = await setup(binding);
    const file = await cms.media.upload({
      file: svgFixture(100, 100),
      filename: "logo.svg",
      contentType: "image/svg+xml",
    });
    expect(file.mimeType).toBe("image/svg+xml");
    expect(binding.renders).toBe(0);
    await cms.close();
  });

  test("a named size is rendered once on the Worker, then served from storage", async () => {
    const binding = emulatedBinding();
    const { cms } = await setup(binding);
    const file = await cms.media.upload({
      file: pngFixture(1200, 800),
      filename: "photo.png",
      contentType: "image/png",
    });
    const afterUpload = binding.renders;

    const thumb = await cms.media.variant({ id: file.id, variant: "thumb" });
    expect(thumb).toMatchObject({
      cached: false,
      contentType: "image/webp",
      width: 320,
      height: 320,
    });
    expect(thumb?.key).toEndWith("/thumb.webp");
    expect(probeImage(await bytesOf(thumb!.body))).toMatchObject({
      width: 320,
      height: 320,
    });

    const again = await cms.media.variant({ id: file.id, variant: "thumb" });
    expect(again?.cached).toBe(true);
    await bytesOf(again!.body);
    expect(binding.renders).toBe(afterUpload + 1);

    const card = await cms.media.variant({ id: file.id, variant: "card" });
    expect([card?.width, card?.height]).toEqual([768, 512]);
    await bytesOf(card!.body);
    await cms.close();
  });

  test("the crop and the focal point reach the binding as a trim", async () => {
    const binding = emulatedBinding();
    const { cms } = await setup(binding);
    const file = await cms.media.upload({
      file: pngFixture(1000, 800),
      filename: "photo.png",
      contentType: "image/png",
    });
    await cms.media.update({
      id: file.id,
      crop: { x: 100, y: 100, width: 600, height: 400 },
      focalPoint: { x: 0.5, y: 0.5 },
    });

    const thumb = await cms.media.variant({
      id: file.id,
      variant: "thumb",
      refresh: true,
    });
    expect([thumb?.width, thumb?.height]).toEqual([320, 320]);
    await bytesOf(thumb!.body);
    await cms.close();
  });

  test("with no binding the upload fails loudly instead of storing a wrong file", async () => {
    const adapter = sqlite(new Database(":memory:"));
    const cms = heyoCms({
      database: () => adapter,
      collections: {
        posts: defineCollection({
          fields: { title: text({ required: true }) },
        }),
      },
      uploads: {
        storage: memory({ baseUrl: "https://cdn.test/media" }),
        images: {
          processor: cloudflareImages(() => undefined),
          convert: { to: "webp" },
        },
      },
    });
    adapter.useSchema(cms.schema);
    await adapter.applyMigration(
      adapter.render(adapter.plan(emptySnapshot(), cms.schema), "0000_cf"),
    );

    await expect(
      cms.media.upload({
        file: pngFixture(100, 100),
        filename: "a.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow(/Images binding/);
    await cms.close();
  });
});
