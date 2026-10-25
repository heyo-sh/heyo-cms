import { describe, expect, test } from "bun:test";

import { CmsError } from "../src/errors";
import {
  cloudflareImages,
  cloudflareTransform,
  type CloudflareImagesBinding,
} from "../src/media/cloudflare";
import type { ImageInfo, ImageTransform } from "../src/types/media";

/**
 * The binding never runs here — workerd owns the real one — so these tests
 * are about the translation: which `transform()` and `output()` options one
 * `ImageTransform` becomes, which is the entire behaviour of the processor
 * that this package is responsible for.
 */

function info(
  width: number,
  height: number,
  contentType = "image/jpeg",
): ImageInfo {
  return {
    format: (contentType.split("/")[1] ?? "jpeg") as ImageInfo["format"],
    contentType,
    width,
    height,
  };
}

interface RecordedCalls {
  transforms: Record<string, unknown>[];
  output?: Record<string, unknown>;
}

function fakeBinding(
  result: { bytes?: Uint8Array; contentType?: string } = {},
): { binding: CloudflareImagesBinding; calls: RecordedCalls } {
  const calls: RecordedCalls = { transforms: [] };
  const transformer = {
    transform(options: Record<string, unknown>) {
      calls.transforms.push(options);
      return transformer;
    },
    async output(options: Record<string, unknown>) {
      calls.output = options;
      return {
        contentType: () => result.contentType ?? String(options.format),
        image: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(result.bytes ?? new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
      };
    },
  };
  return { binding: { input: () => transformer }, calls };
}

describe("cloudflareImages", () => {
  test("declares what the binding can decode", () => {
    const processor = cloudflareImages(fakeBinding().binding);
    expect(processor.id).toBe("cloudflare-images");
    expect(processor.supports("image/jpeg")).toBe(true);
    expect(processor.supports("IMAGE/WEBP")).toBe(true);
    expect(processor.supports("image/svg+xml")).toBe(false);
    expect(processor.supports("image/tiff")).toBe(false);
  });

  test("convert to webp is an output format, not a transform", async () => {
    const { binding, calls } = fakeBinding();
    const processor = cloudflareImages(binding);
    const result = await processor.transform(
      new Uint8Array([0]),
      { format: "webp", quality: 82 },
      info(1000, 800),
    );
    expect(calls.transforms).toHaveLength(0);
    expect(calls.output).toEqual({ format: "image/webp", quality: 82 });
    expect(result.contentType).toBe("image/webp");
    // The fake's bytes are not an image, so the dimensions come from the
    // plan: no resize means the original's.
    expect(result.width).toBe(1000);
    expect(result.height).toBe(800);
  });

  test("without a format the original content type is re-encoded", async () => {
    const { binding, calls } = fakeBinding();
    await cloudflareImages(binding).transform(
      new Uint8Array([0]),
      { width: 100 },
      info(1000, 800, "image/png"),
    );
    expect(calls.output).toEqual({ format: "image/png" });
  });

  test("a binding may arrive through an async function", async () => {
    const { binding, calls } = fakeBinding();
    const processor = cloudflareImages(async () => binding);
    await processor.transform(new Uint8Array([0]), { format: "webp" }, info(10, 10)); // prettier-ignore
    expect(calls.output?.format).toBe("image/webp");
  });

  test("no binding is an error when pixels are asked for, not before", async () => {
    const processor = cloudflareImages(() => undefined);
    expect(processor.supports("image/jpeg")).toBe(true);
    expect(
      processor.transform(
        new Uint8Array([0]),
        { format: "webp" },
        info(10, 10),
      ),
    ).rejects.toMatchObject(
      expect.objectContaining({ code: "image_processor_missing" }) as CmsError,
    );
  });
});

describe("cloudflareTransform", () => {
  const plan = (size: [number, number], transform: ImageTransform) =>
    cloudflareTransform(info(size[0], size[1]), transform);

  test('"inside" becomes scale-down, which never enlarges', () => {
    expect(plan([4000, 3000], { width: 1920 })).toEqual({
      options: { width: 1920, fit: "scale-down" },
      width: 1920,
      height: 1440,
    });
    // A 400px logo asked for at 1920 stays 400px.
    expect(plan([400, 300], { width: 1920, fit: "inside" })).toEqual({
      options: { width: 1920, fit: "scale-down" },
      width: 400,
      height: 300,
    });
  });

  test('"cover" is clamped to the source instead of enlarging', () => {
    expect(
      plan([400, 1000], { width: 800, height: 800, fit: "cover" }),
    ).toEqual({
      options: { width: 400, height: 400, fit: "cover" },
      width: 400,
      height: 400,
    });
    expect(
      plan([1000, 800], { width: 320, height: 320, fit: "cover" }),
    ).toEqual({
      options: { width: 320, height: 320, fit: "cover" },
      width: 320,
      height: 320,
    });
  });

  test('"contain" letterboxes, which Cloudflare calls pad', () => {
    expect(
      plan([1000, 500], { width: 400, height: 400, fit: "contain" }).options,
    ).toEqual({ width: 400, height: 400, fit: "pad" });
  });

  test('"outside" is computed, since Cloudflare has no such fit', () => {
    // Covering 500x500 from 1000x800 needs scale 0.625.
    expect(
      plan([1000, 800], { width: 500, height: 500, fit: "outside" }),
    ).toEqual({
      options: { width: 625, height: 500, fit: "scale-down" },
      width: 625,
      height: 500,
    });
    // And never enlarges either.
    expect(
      plan([400, 300], { width: 500, height: 500, fit: "outside" }),
    ).toEqual({
      options: { width: 400, height: 300, fit: "scale-down" },
      width: 400,
      height: 300,
    });
  });

  test("crop and focal point resolve to one trim, like the sharp processor", () => {
    // The same frame image-framing.test.ts proves for `sourceRegion`.
    const result = plan([1000, 800], {
      crop: { x: 200, y: 100, width: 600, height: 400 },
      position: { x: 0.55, y: 0.375 },
      fit: "cover",
      width: 200,
      height: 200,
    });
    expect(result).toEqual({
      options: {
        trim: { top: 100, left: 350, width: 400, height: 400 },
        width: 200,
        height: 200,
        fit: "cover",
      },
      width: 200,
      height: 200,
    });
  });

  test("a crop alone trims and reports the cropped size", () => {
    expect(
      plan([1000, 800], { crop: { x: 200, y: 100, width: 600, height: 400 } }),
    ).toEqual({
      options: { trim: { top: 100, left: 200, width: 600, height: 400 } },
      width: 600,
      height: 400,
    });
  });

  test("only a format means no transform call at all", () => {
    expect(plan([1000, 800], { format: "webp", quality: 80 })).toEqual({
      options: null,
      width: 1000,
      height: 800,
    });
  });
});
