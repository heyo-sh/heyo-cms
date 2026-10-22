import { describePanel } from "../../panel";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject } from "../../types/json";
import { json } from "../respond";
import type { RouteRecord } from "../router";
import { okJson } from "../spec";

/**
 * `GET /panel`: the configuration, as data.
 *
 * The panel is one static bundle that has to render every deployment, so the
 * first thing it does is ask what this one is: which collections exist, what
 * fields they carry, which languages are registered, whether there is a
 * trash, what the caller is allowed to press. All of it is derived from the
 * configuration — there is no second place to maintain it, which is the same
 * argument that produced the auto-router and the generated OpenAPI document.
 *
 * Open to anonymous callers on purpose. It describes the shape of the
 * deployment, never its content and never a secret, and the sign-in screen
 * needs the title and the enabled methods *before* anybody is signed in. The
 * per-actor parts — `can`, and field-level access — simply answer for
 * "nobody" then, which is the correct answer for nobody.
 */
export function panelRoutes(cms: CmsInstance): RouteRecord[] {
  return [
    {
      method: "GET",
      path: "/panel",
      source: "core",
      handler: async (context) => {
        // The language switcher is drawn from the same payload as everything
        // else: one call answers the whole first screen.
        return json(
          describePanel(cms._config, context.actor, cms.locales.list(), {
            setupRequired: await setupRequired(cms),
          }) as unknown as JsonObject,
        );
      },
      openapi: {
        summary: "What the panel renders",
        description:
          "Collections, fields, languages, media settings and what the caller may do, derived from the configuration. Public, because the sign-in screen is rendered from it; it contains no content and no credentials, and the per-actor flags are advisory — the engine decides every read and write.",
        tags: ["admin"],
        security: false,
        responses: {
          "200": okJson(
            { type: "object" },
            "The panel's description of this deployment.",
          ),
        },
      },
    },
  ];
}

/**
 * Whether the sign-in screen should offer to create the first account.
 *
 * Degrades to `false` rather than throwing: this is the first request the
 * panel makes, and a database that cannot be counted yet must not replace the
 * sign-in screen with a stack trace. `false` is also the safe side of the
 * mistake — it hides a form rather than opening one.
 */
async function setupRequired(cms: CmsInstance): Promise<boolean> {
  try {
    return await cms.auth.setup.required();
  } catch {
    return false;
  }
}
