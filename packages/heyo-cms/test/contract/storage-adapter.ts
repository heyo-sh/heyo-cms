import { describe, expect, test } from "bun:test";

import type { StorageAdapter } from "../../src/types/storage";

export interface StorageUnderTest {
  name: string;
  create(): Promise<StorageAdapter> | StorageAdapter;
  cleanup?(): Promise<void> | void;
}

/**
 * The contract every storage adapter has to satisfy.
 *
 * Four methods, so four groups of assertions: a file goes in, comes back out,
 * disappears on request, and has a URL. The media lifecycle in stage 6 depends
 * on exactly these behaviours — in particular on `get` answering `null` for a
 * missing key rather than throwing, because a purge that raced with a read
 * must not take a request down.
 */
export function runStorageAdapterContract(entry: StorageUnderTest): void {
  describe(`storage adapter contract: ${entry.name}`, () => {
    const bytes = new TextEncoder().encode("heyo");

    test("stores and reads an object back", async () => {
      const storage = await entry.create();
      await storage.put("2026/photo.webp", bytes, {
        contentType: "image/webp",
        size: bytes.byteLength,
      });

      const stream = await storage.get("2026/photo.webp");
      expect(stream).not.toBeNull();
      const read = await new Response(stream as ReadableStream).arrayBuffer();
      expect(new TextDecoder().decode(read)).toBe("heyo");
      await entry.cleanup?.();
    });

    test("accepts a stream as well as bytes", async () => {
      const storage = await entry.create();
      const stream = new Blob([bytes as unknown as BlobPart]).stream();
      await storage.put("stream.bin", stream, {
        contentType: "application/octet-stream",
      });
      const read = await storage.get("stream.bin");
      expect(read).not.toBeNull();
      await entry.cleanup?.();
    });

    test("answers null for a key that is not there", async () => {
      const storage = await entry.create();
      expect(await storage.get("missing.webp")).toBeNull();
      await entry.cleanup?.();
    });

    test("deletes in batches and tolerates missing keys", async () => {
      const storage = await entry.create();
      await storage.put("a.txt", bytes, { contentType: "text/plain" });
      await storage.put("b.txt", bytes, { contentType: "text/plain" });

      // The media collector deletes in batches and races with reclaims, so a
      // key that vanished between the two must not fail the batch.
      await storage.delete(["a.txt", "b.txt", "never-existed.txt"]);
      expect(await storage.get("a.txt")).toBeNull();
      expect(await storage.get("b.txt")).toBeNull();
      await entry.cleanup?.();
    });

    test("builds a URL without touching the network", async () => {
      const storage = await entry.create();
      const url = storage.url("2026/photo.webp");
      expect(typeof url).toBe("string");
      expect(url).toContain("2026/photo.webp");
      await entry.cleanup?.();
    });

    test("reports size and type when it implements head", async () => {
      const storage = await entry.create();
      if (!storage.head) return;
      await storage.put("sized.txt", bytes, { contentType: "text/plain" });
      const info = await storage.head("sized.txt");
      expect(info?.size).toBe(bytes.byteLength);
      expect(await storage.head("absent.txt")).toBeNull();
      await entry.cleanup?.();
    });
  });
}
