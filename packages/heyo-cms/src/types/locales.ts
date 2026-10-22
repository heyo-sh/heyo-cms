/**
 * A language the content can be written in.
 *
 * Derived from `i18n.locales`, which is a list of codes and nothing else:
 * `name` and `rtl` are looked up from the code, so a deployment that wants
 * French writes `"fr"` and still gets "French" in the panel's switcher.
 */
export interface LocaleRecord {
  code: string;
  /** The English name of the language: `"pl"` reads as "Polish". */
  name: string;
  rtl: boolean;
  /** Whether reads fall back to it. Exactly one locale has this. */
  isDefault: boolean;
}

/**
 * `cms.locales`.
 *
 * The list, not the resolver: which languages exist. Which one a read speaks,
 * and what it falls back to, is decided per call from `i18n.defaultLocale`.
 *
 * Languages are configuration — adding one is a line in `i18n.locales` and a
 * deploy, not a row somebody can delete from a panel at 18:00 on a Friday.
 * Removing a code from the list leaves the translations stored under it
 * alone, so putting it back brings them back.
 */
export interface CmsLocales {
  list(): LocaleRecord[];
}
