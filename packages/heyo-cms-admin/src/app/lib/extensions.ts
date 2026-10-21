import type { PanelConfig, PanelField } from "@heyo-sh/heyo-cms/types";
import type { ComponentType } from "react";

/**
 * How a plugin renders something in a panel it was not compiled into.
 *
 * The bundle is static and the configuration is not: a deployment installs a
 * plugin today and the panel that has to draw its field was built months
 * ago. Components cannot travel as JSON, so what travels is a URL. The
 * plugin serves a script — usually from one of its own routes — the panel
 * loads it before the first render, and the script registers its controls
 * against the global below.
 *
 * ```js
 * // served by the plugin at /api/heyo-cms/reviews/panel.js
 * window.heyoCmsPanel.registerField("stars", StarsInput);
 * ```
 *
 * The contract is deliberately tiny: a React component taking the same props
 * the built-in controls take. Anything larger would be a plugin API that has
 * to be versioned against the panel's internals, which is the thing this
 * design exists to avoid.
 */

export interface PanelFieldComponentProps {
  field: PanelField;
  value: unknown;
  onChange: (value: unknown) => void;
  document: Record<string, unknown>;
  disabled?: boolean;
  id?: string;
}

export type PanelFieldComponent = ComponentType<PanelFieldComponentProps>;
export type PanelViewComponent = ComponentType<Record<string, unknown>>;

const fields = new Map<string, PanelFieldComponent>();
const views = new Map<string, PanelViewComponent>();

export interface PanelExtensionApi {
  registerField(type: string, component: PanelFieldComponent): void;
  registerView(name: string, component: PanelViewComponent): void;
  /** The panel's React, so a plugin script does not ship a second copy. */
  react?: unknown;
}

export function fieldComponent(type: string): PanelFieldComponent | undefined {
  return fields.get(type);
}

export function viewComponent(name: string): PanelViewComponent | undefined {
  return views.get(name);
}

/**
 * Installs the global and loads what the configuration asked for.
 *
 * Failures are reported and survived. A plugin whose script 404s must not
 * stop an editor from opening a document: the field it would have rendered
 * falls back to the built-in control for its column type, which is the same
 * thing that happens when no plugin is installed at all.
 */
export async function loadPanelExtensions(
  config: PanelConfig,
  options: { react?: unknown; load?: (url: string) => Promise<void> } = {},
): Promise<string[]> {
  const api: PanelExtensionApi = {
    registerField: (type, component) => fields.set(type, component),
    registerView: (name, component) => views.set(name, component),
    ...(options.react === undefined ? {} : { react: options.react }),
  };
  (globalThis as { heyoCmsPanel?: PanelExtensionApi }).heyoCmsPanel = api;

  const failures: string[] = [];
  const load = options.load ?? loadScript;

  for (const plugin of config.plugins) {
    for (const script of plugin.scripts) {
      const url = script.startsWith("http")
        ? script
        : `${config.basePath}${script.startsWith("/") ? script : `/${script}`}`;
      try {
        await load(url);
      } catch {
        failures.push(`${plugin.id}: ${url}`);
      }
    }
  }
  return failures;
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = url;
    element.type = "module";
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error(url)), {
      once: true,
    });
    document.head.append(element);
  });
}
