/**
 * What a locale code is called, in English.
 *
 * The configuration is a list of codes — `["en", "pl"]` — because that is all
 * a deployment should have to type. A panel cannot put `pl` in a language
 * switcher and call it a language, so the display name is looked up here
 * rather than asked for: one table, filled in once, instead of a `name` on
 * every entry of every configuration.
 *
 * English names rather than endonyms ("Polish", not "Polski"): the panel's
 * chrome is English, and a switcher that mixes the two is a list nobody can
 * scan.
 */
export const LOCALE_NAMES: Record<string, string> = {
  af: "Afrikaans",
  am: "Amharic",
  ar: "Arabic",
  az: "Azerbaijani",
  be: "Belarusian",
  bg: "Bulgarian",
  bn: "Bengali",
  bs: "Bosnian",
  ca: "Catalan",
  cs: "Czech",
  cy: "Welsh",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  eo: "Esperanto",
  es: "Spanish",
  et: "Estonian",
  eu: "Basque",
  fa: "Persian",
  fi: "Finnish",
  fil: "Filipino",
  fo: "Faroese",
  fr: "French",
  ga: "Irish",
  gl: "Galician",
  gu: "Gujarati",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  hy: "Armenian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ka: "Georgian",
  kk: "Kazakh",
  km: "Khmer",
  kn: "Kannada",
  ko: "Korean",
  ku: "Kurdish",
  ky: "Kyrgyz",
  lo: "Lao",
  lt: "Lithuanian",
  lv: "Latvian",
  mk: "Macedonian",
  ml: "Malayalam",
  mn: "Mongolian",
  mr: "Marathi",
  ms: "Malay",
  mt: "Maltese",
  my: "Burmese",
  nb: "Norwegian Bokmål",
  ne: "Nepali",
  nl: "Dutch",
  nn: "Norwegian Nynorsk",
  no: "Norwegian",
  pa: "Punjabi",
  pl: "Polish",
  ps: "Pashto",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  sq: "Albanian",
  sr: "Serbian",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  tk: "Turkmen",
  tl: "Tagalog",
  tr: "Turkish",
  tt: "Tatar",
  uk: "Ukrainian",
  ur: "Urdu",
  uz: "Uzbek",
  vi: "Vietnamese",
  zh: "Chinese",
  zu: "Zulu",
};

/**
 * Regions, for the codes that carry one.
 *
 * Only the ones a CMS actually sees: `pt-BR` and `en-GB` are configured all
 * the time, `de-AT-1996` is not. An unknown region is kept verbatim, so a
 * valid code never loses information on its way to a label.
 */
const REGION_NAMES: Record<string, string> = {
  AR: "Argentina",
  AT: "Austria",
  AU: "Australia",
  BE: "Belgium",
  BR: "Brazil",
  CA: "Canada",
  CH: "Switzerland",
  CL: "Chile",
  CN: "China",
  CO: "Colombia",
  CZ: "Czechia",
  DE: "Germany",
  DK: "Denmark",
  ES: "Spain",
  FI: "Finland",
  FR: "France",
  GB: "United Kingdom",
  HK: "Hong Kong",
  IE: "Ireland",
  IN: "India",
  IT: "Italy",
  JP: "Japan",
  KR: "South Korea",
  MX: "Mexico",
  NL: "Netherlands",
  NO: "Norway",
  NZ: "New Zealand",
  PL: "Poland",
  PT: "Portugal",
  RU: "Russia",
  SE: "Sweden",
  TW: "Taiwan",
  UA: "Ukraine",
  US: "United States",
  ZA: "South Africa",
};

/** Languages written right to left; the panel mirrors its inputs for them. */
const RTL_LANGUAGES = new Set(["ar", "arc", "dv", "fa", "he", "ku", "ps", "sd", "ug", "ur", "yi"]); // prettier-ignore

/**
 * `"pl"` → `"Polish"`, `"pt-BR"` → `"Portuguese (Brazil)"`.
 *
 * An unknown code is returned as it was written rather than guessed at: a
 * switcher reading `"kw"` is a configuration to fix, and inventing a name for
 * it would hide that.
 */
export function localeName(code: string): string {
  const exact = LOCALE_NAMES[code];
  if (exact) return exact;

  const [language, region] = code.split("-");
  const base = language === undefined ? undefined : LOCALE_NAMES[language.toLowerCase()]; // prettier-ignore
  if (!base) return code;
  if (region === undefined) return base;

  const upper = region.toUpperCase();
  return `${base} (${REGION_NAMES[upper] ?? upper})`;
}

/** Whether a code names a right-to-left language, region tag included. */
export function isRtlLocale(code: string): boolean {
  const language = code.split("-")[0];
  return language !== undefined && RTL_LANGUAGES.has(language.toLowerCase());
}
