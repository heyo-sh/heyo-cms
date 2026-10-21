import { Select, Tooltip, cn } from "@heyo-sh/heyo-ui";

import { usePanel } from "../lib/panel";

/**
 * One language for the whole panel, chosen at the trail's level.
 *
 * Per-screen language choices sound flexible and are a trap: an editor who
 * switches a list to German and then opens a document expects the German
 * document. Every read and write the panel makes carries this value as
 * `?locale=`, so the engine resolves one language and the panel never has to
 * merge two.
 *
 * It is a select, in the navigation row, beside the trail — and it is the
 * only thing in the panel that names the language. Badges repeating "en" on
 * every localized field said the same fact eleven times per screen and none
 * of them could be clicked.
 */
export function LocaleSwitcher({
  className,
  onValueChange,
  disabled,
}: {
  className?: string;
  onValueChange?: (locale: string) => void;
  disabled?: boolean;
}) {
  const { config, locale, setLocale } = usePanel();

  // Keep the control present for a one-language deployment too. It makes the
  // language context explicit in every editor and does not make the bar jump
  // when a second locale is configured later.
  //
  // The label is the language, never the code: `i18n.locales` is a list of
  // codes and the server resolves each one to its English name, so a list
  // somebody configured as `["en", "pl"]` reads "English" and "Polish".
  const options = config.i18n.locales.map((entry) => ({
    value: entry.code,
    label: entry.name,
  }));

  const current = config.i18n.locales.find((entry) => entry.code === locale);

  return (
    <Tooltip content="Language being edited">
      <Select
        value={locale}
        onValueChange={(next) => (onValueChange ?? setLocale)(String(next))}
        disabled={disabled}
        // Also on the root, not only on the popup: `Select.Value` resolves a
        // value to its label from here, so the trigger reads "English" on
        // first paint instead of "en" until somebody opens the list.
        items={options}
        aria-label="Language"
      >
        <Select.Trigger
          size="sm"
          aria-label="Language"
          className={cn("w-auto max-w-44 shrink-0", className)}
        >
          {/* The code on a phone, the language everywhere else: "en" is
              unambiguous once you know the panel edits one language at a
              time, and the bar has three other things to fit. */}
          <span className="min-w-0 truncate sm:hidden">
            {locale.toUpperCase()}
          </span>
          <span className="hidden min-w-0 truncate sm:inline">
            {current?.name ?? locale}
          </span>
        </Select.Trigger>
        <Select.Content items={options} />
      </Select>
    </Tooltip>
  );
}
