import { describe, expect, test } from "bun:test";

import { createAdminAssets, type PanelBundle } from "../src/assets";
import { adminAssets } from "../src/index";

/**
 * Stage 8: the panel, as the handler sees it.
 *
 * The application itself is exercised by clicking it; what is asserted here
 * is the contract between the bundle and `cms.handler` — the shell carries
 * the mount point, hashed files are served with their own ETag, a path that
 * is not in the bundle is `null` so the handler can fall back to the shell,
 * and a source checkout says it is unbuilt instead of answering with a blank
 * page.
 */

const bundle: PanelBundle = {
  id: "heyo-cms-admin@test",
  entry: { script: "assets/main-abc123.js", style: "assets/main-abc123.css" },
  files: [
    {
      path: "assets/main-abc123.js",
      content: "console.log('panel');",
      encoding: "utf8",
      contentType: "text/javascript; charset=utf-8",
      etag: '"abc123"',
    },
    {
      path: "assets/icon.png",
      content: "aGVsbG8=",
      encoding: "base64",
      contentType: "image/png",
      etag: '"def456"',
    },
  ],
  built: true,
};

describe("the panel bundle", () => {
  test("the shell carries the mount point, so deep links resolve", async () => {
    const assets = createAdminAssets(bundle);
    assets.configure?.({
      basePath: "/cms",
      panelPath: "/cms/panel-ui",
      title: "Acme",
    });

    const shell = await assets.asset("");
    const html = String(shell?.body);

    expect(shell?.contentType).toContain("text/html");
    expect(html).toContain('"basePath":"/cms"');
    expect(html).toContain('"panelPath":"/cms/panel-ui"');
    expect(html).toContain("/cms/panel-ui/assets/main-abc123.js");
    expect(html).toContain("/cms/panel-ui/assets/main-abc123.css");
    expect(html).toContain("<title>Acme</title>");
    // The stored panel preference reaches `<html>` before the stylesheet, so
    // a light panel is never first painted using the OS's dark palette.
    expect(html.indexOf("heyo-cms:theme")).toBeLessThan(
      html.indexOf("assets/main-abc123.css"),
    );
    expect(html).toContain('root.setAttribute("data-mode", mode)');
    // Not indexed: a CMS panel in search results is a list of targets.
    expect(html).toContain("noindex");
  });

  test("the shell is never cached, because it names hashed files", async () => {
    const assets = createAdminAssets(bundle);
    const shell = await assets.asset("");
    expect(shell?.cacheControl).toBe("no-cache");
    expect(shell?.etag).toBeTruthy();
  });

  test("re-mounting rewrites the shell", async () => {
    const assets = createAdminAssets(bundle);
    assets.configure?.({ basePath: "/a", panelPath: "/a/admin", title: "A" });
    const first = String((await assets.asset(""))?.body);
    assets.configure?.({ basePath: "/b", panelPath: "/b/admin", title: "B" });
    const second = String((await assets.asset(""))?.body);

    expect(first).toContain("/a/admin/assets");
    expect(second).toContain("/b/admin/assets");
  });

  test("a title override beats the configuration's", async () => {
    const assets = createAdminAssets(bundle, { title: "Newsroom" });
    assets.configure?.({
      basePath: "/api/heyo-cms",
      panelPath: "/api/heyo-cms/admin",
      title: "Acme",
    });
    expect(String((await assets.asset(""))?.body)).toContain(
      "<title>Newsroom</title>",
    );
  });

  test("text files are served as text and binary as bytes", async () => {
    const assets = createAdminAssets(bundle);

    const script = await assets.asset("assets/main-abc123.js");
    expect(script?.body).toBe("console.log('panel');");
    expect(script?.etag).toBe('"abc123"');

    const icon = await assets.asset("assets/icon.png");
    expect(icon?.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(icon?.body as Uint8Array)).toBe("hello");
  });

  test("a leading slash is the same file", async () => {
    const assets = createAdminAssets(bundle);
    expect(await assets.asset("/assets/main-abc123.js")).not.toBeNull();
  });

  test("an unknown path is null, so the handler can decide", async () => {
    const assets = createAdminAssets(bundle);
    // The handler turns this into the shell for a route and a 404 for a
    // missing file; deciding that here would duplicate the rule.
    expect(await assets.asset("assets/missing.js")).toBeNull();
  });

  test("index.html is the shell, since that is what a browser asks for", async () => {
    const assets = createAdminAssets(bundle);
    expect(String((await assets.asset("index.html"))?.body)).toContain(
      "<!doctype html>",
    );
  });

  test("an unbuilt checkout says so instead of serving a blank page", async () => {
    // `adminAssets()` from source, before `bun run build` has inlined
    // anything: the published package replaces this bundle.
    const assets = adminAssets();
    const html = String((await assets.asset(""))?.body);

    if (assets.id.endsWith("unbuilt")) {
      expect(html).toContain("The panel is not built");
      expect(html).toContain("bun run --filter @heyo-sh/heyo-cms-admin build");
    } else {
      expect(html).toContain("heyo-cms-root");
    }
  });
});
