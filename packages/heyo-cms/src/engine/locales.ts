import type { LocaleArgs } from "../types/api";
import type { ResolvedCmsConfig } from "../types/config";
import type { JsonObject, JsonValue } from "../types/json";

/**
 * Everything a read needs to know about language, resolved once per call.
 *
 * Fallback is decided here and nowhere else: a field that resolves one way in
 * the REST layer and another way in a hook would make `_fallback` a claim
 * nobody could rely on.
 */
export interface LocaleContext {
  /** The locale the caller asked for. */
  locale: string;
  /** The order values are looked up in, starting with `locale` itself. */
  chain: string[];
}

/**
 * One rule, not a configuration section: a field with no value in the
 * requested language is answered from `i18n.defaultLocale`, and the response
 * says which fields those were. A caller that wants the gaps instead of the
 * substitution passes `fallbackLocale: false` for that one call — which is
 * exactly what the panel does while somebody is filling translations in.
 */
export function localeContext(
  config: ResolvedCmsConfig,
  args: LocaleArgs = {},
): LocaleContext {
  const locale = args.locale ?? config.i18n.defaultLocale;
  return { locale, chain: [locale, ...chainFor(config, locale, args)] };
}

function chainFor(
  config: ResolvedCmsConfig,
  locale: string,
  args: LocaleArgs,
): string[] {
  // A per-call override wins over the default rule, in both directions: an
  // explicit `false` turns substitution off for this read alone, and a code
  // forces one specific source.
  if (args.fallbackLocale === false) return [];
  if (typeof args.fallbackLocale === "string") {
    return args.fallbackLocale === locale ? [] : [args.fallbackLocale];
  }

  const target = config.i18n.defaultLocale;
  return target === locale ? [] : [target];
}

export interface ResolvedValue {
  value: JsonValue;
  /** The locale the value actually came from, `null` when nothing matched. */
  from: string | null;
}

/**
 * Picks one locale's value out of a stored `{ [locale]: value }` map.
 *
 * Fallback is per field, not per document: partial translations are the norm,
 * so a document with a translated title and an untranslated body has to be
 * expressible (section 9).
 */
export function resolveLocalized(
  stored: JsonValue | undefined,
  locale: LocaleContext,
): ResolvedValue {
  const map = isLocaleMap(stored) ? stored : {};
  for (const code of locale.chain) {
    const value = map[code];
    if (value !== undefined && value !== null) return { value, from: code };
  }
  return { value: null, from: null };
}

/** Writes one locale into a stored map, leaving the other languages alone. */
export function writeLocalized(
  stored: JsonValue | undefined,
  locale: string,
  value: JsonValue,
): JsonObject {
  const map = isLocaleMap(stored) ? { ...stored } : {};
  map[locale] = value;
  return map;
}

/**
 * A localized value is an object keyed by locale code.
 *
 * Arrays are excluded explicitly: a `multiselect` holds an array, and
 * mistaking one for a locale map would silently return the first element as
 * if it were a translation.
 */
function isLocaleMap(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
