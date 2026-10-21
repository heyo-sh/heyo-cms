import type { ResolvedCmsConfig } from "../types/config";
import type { LocaleRecord } from "../types/locales";
import { isRtlLocale, localeName } from "./names";

export { isRtlLocale, localeName, LOCALE_NAMES } from "./names";

/**
 * The configured languages, named.
 *
 * In the order they were configured: a switcher that reorders what somebody
 * typed is a switcher whose order nobody can control. The default locale is
 * flagged rather than hoisted, for the same reason.
 */
export function localeRecords(config: ResolvedCmsConfig): LocaleRecord[] {
  return config.i18n.locales.map((code) => ({
    code,
    name: localeName(code),
    rtl: isRtlLocale(code),
    isDefault: code === config.i18n.defaultLocale,
  }));
}
