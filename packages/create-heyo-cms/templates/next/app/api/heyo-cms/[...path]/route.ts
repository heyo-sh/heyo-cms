import { cmsHandler } from "@heyo-sh/heyo-cms/next";

import { cms } from "../../../../heyo-cms.config.ts";

/**
 * The whole CMS, mounted. This file never changes again.
 *
 * Everything the CMS answers is behind this one catch-all: CRUD for every
 * collection, the media library, editor authentication, the trash, the
 * language registry, the audit trail, the OpenAPI document, the admin panel
 * and every route a plugin registers. Adding a collection or installing a
 * plugin adds routes here without touching the file (section 10).
 *
 *   GET  /api/heyo-cms/posts
 *   POST /api/heyo-cms/media/upload
 *   GET  /api/heyo-cms/openapi.json
 *   GET  /api/heyo-cms/admin          ← the panel
 */
export const { GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS } = cmsHandler(cms);

/**
 * The CMS reads and writes a database on every request, so nothing here can
 * be prerendered or cached by the router.
 */
export const dynamic = "force-dynamic";
