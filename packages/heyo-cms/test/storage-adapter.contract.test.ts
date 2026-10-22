import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { azure, gcs, r2, s3 } from "../src/storage/providers";
import { local, memory } from "../src/storage/local";
import { fakeObjectStore, fakeR2Bucket } from "./fake-object-store";
import { runStorageAdapterContract } from "./contract/storage-adapter";

runStorageAdapterContract({ name: "memory", create: () => memory() });

let directory: string | undefined;
runStorageAdapterContract({
  name: "local",
  create: async () => {
    directory = await mkdtemp(join(tmpdir(), "heyo-cms-storage-"));
    return local({ directory, baseUrl: "/media" });
  },
  cleanup: async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  },
});

const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

runStorageAdapterContract({
  name: "s3",
  create: () =>
    s3({
      bucket: "heyo-media",
      region: "eu-central-1",
      ...credentials,
      fetch: fakeObjectStore().fetch,
    })(),
});

runStorageAdapterContract({
  name: "gcs",
  create: () =>
    gcs({
      bucket: "heyo-media",
      ...credentials,
      fetch: fakeObjectStore().fetch,
    })(),
});

runStorageAdapterContract({
  name: "azure",
  create: () =>
    azure({
      account: "heyo",
      container: "media",
      accountKey: btoa("an-account-key-that-is-base64"),
      fetch: fakeObjectStore().fetch,
    })(),
});

runStorageAdapterContract({
  name: "r2 (binding)",
  create: () => r2(fakeR2Bucket())(),
});

/**
 * The parts of the cloud adapters the generic contract cannot see.
 *
 * Everything above proves a file goes in and comes back out. These prove the
 * request that carried it was the request the provider expects — which is the
 * half that fails in production rather than in a test, because an unsigned or
 * wrongly addressed request still round-trips perfectly against a store that
 * does not check.
 */
describe("cloud storage requests", () => {
  const bytes = new TextEncoder().encode("heyo");

  test("S3 signs every request and addresses the bucket as a subdomain", async () => {
    const store = fakeObjectStore();
    const storage = await s3({
      bucket: "heyo-media",
      region: "eu-central-1",
      ...credentials,
      fetch: store.fetch,
    })();

    await storage.put("2026/photo.webp", bytes, { contentType: "image/webp" });
    const request = store.requests[0];

    expect(request?.url).toBe(
      "https://heyo-media.s3.eu-central-1.amazonaws.com/2026/photo.webp",
    );
    expect(request?.headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(request?.headers.authorization).toContain(
      `Credential=${credentials.accessKeyId}/`,
    );
    expect(request?.headers.authorization).toContain("/eu-central-1/s3/aws4_request"); // prettier-ignore
    // The payload hash is signed, so a proxy that rewrites the body is caught
    // by the provider rather than by nobody.
    expect(request?.headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(request?.headers["content-type"]).toBe("image/webp");
  });

  test("the signature covers the body, so identical requests differ", async () => {
    const store = fakeObjectStore();
    const storage = await s3({
      bucket: "heyo-media",
      region: "us-east-1",
      ...credentials,
      fetch: store.fetch,
    })();

    await storage.put("a.txt", new TextEncoder().encode("one"), {
      contentType: "text/plain",
    });
    await storage.put("a.txt", new TextEncoder().encode("two"), {
      contentType: "text/plain",
    });

    const [first, second] = store.requests;
    expect(first?.headers["x-amz-content-sha256"]).not.toBe(
      second?.headers["x-amz-content-sha256"],
    );
    expect(first?.headers.authorization).not.toBe(second?.headers.authorization); // prettier-ignore
  });

  test("an S3-compatible endpoint is addressed by path", async () => {
    const store = fakeObjectStore();
    const storage = await s3({
      bucket: "heyo-media",
      endpoint: "https://minio.internal:9000",
      ...credentials,
      fetch: store.fetch,
    })();

    await storage.put("x.bin", bytes, { contentType: "application/octet-stream" }); // prettier-ignore
    // A compatible service's bucket is not a subdomain of anything, and its
    // certificate does not cover one.
    expect(store.requests[0]?.url).toBe(
      "https://minio.internal:9000/heyo-media/x.bin",
    );
  });

  test("Azure signs with a shared key and declares a block blob", async () => {
    const store = fakeObjectStore();
    const storage = await azure({
      account: "heyo",
      container: "media",
      accountKey: btoa("an-account-key-that-is-base64"),
      fetch: store.fetch,
    })();

    await storage.put("2026/photo.webp", bytes, { contentType: "image/webp" });
    const request = store.requests[0];

    expect(request?.url).toBe(
      "https://heyo.blob.core.windows.net/media/2026/photo.webp",
    );
    expect(request?.headers.authorization).toStartWith("SharedKey heyo:");
    // Required on every write; without it Azure refuses the request.
    expect(request?.headers["x-ms-blob-type"]).toBe("BlockBlob");
    expect(request?.headers["x-ms-date"]).toBeDefined();
  });

  test("a signed URL carries its own credentials and an expiry", async () => {
    const storage = await s3({
      bucket: "heyo-media",
      region: "eu-central-1",
      ...credentials,
      signedUrls: { enabled: true, expiresIn: "15m" },
      fetch: fakeObjectStore().fetch,
    })();

    const url = new URL(await (storage.signedUrl as (key: string) => Promise<string>)("private/report.pdf")); // prettier-ignore
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a CDN domain serves what the bucket stores", async () => {
    const store = fakeObjectStore();
    const storage = await s3({
      bucket: "heyo-media",
      region: "eu-central-1",
      publicUrl: "https://cdn.example.com",
      ...credentials,
      fetch: store.fetch,
    })();

    await storage.put("2026/photo.webp", bytes, { contentType: "image/webp" });
    // Written straight to the bucket, read through the CDN.
    expect(store.requests[0]?.url).toContain("s3.eu-central-1.amazonaws.com");
    expect(storage.url("2026/photo.webp")).toBe(
      "https://cdn.example.com/2026/photo.webp",
    );
  });

  test("the adapter decides where new objects live", async () => {
    const storage = await s3({
      bucket: "heyo-media",
      region: "eu-central-1",
      ...credentials,
      prefix: (file) => `uploads/${file.id.slice(0, 3)}`,
      fetch: fakeObjectStore().fetch,
    })();

    expect(storage.prefix?.({ id: "med_abc", filename: "a.png" })).toBe(
      "uploads/med",
    );
  });

  test("a missing bucket or credential is refused where it can be explained", () => {
    expect(() => s3({ bucket: "", region: "eu-central-1" })).toThrow(
      /needs a bucket/,
    );
    expect(() => s3({ bucket: "b" })).toThrow(/needs a region/);
    // Credentials are resolved when the adapter is built, not when the module
    // loads: a template has to start on a laptop that has no bucket.
    const factory = s3({
      bucket: "b",
      region: "eu-central-1",
      accessKeyId: "",
      secretAccessKey: "",
    });
    const previous = process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_ACCESS_KEY_ID;
    expect(() => factory()).toThrow(/AWS_ACCESS_KEY_ID/);
    if (previous !== undefined) process.env.AWS_ACCESS_KEY_ID = previous;
  });
});
