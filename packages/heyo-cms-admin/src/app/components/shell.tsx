import {
  Avatar,
  Badge,
  Button,
  Command,
  Dropdown,
  Sidebar,
  cn,
  controlSizeVariants,
  controlTriggerBase,
} from "@heyo-sh/heyo-ui";
import {
  IconFolder,
  IconHome,
  IconLogout,
  IconMoon,
  IconPhoto,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSun,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

import { useAssistant } from "../lib/assistant";
import { usePanel } from "../lib/panel";
import { Link, useRouter } from "../lib/router";
import { AiAssistant } from "./ai-assistant";
import { CommandPalette } from "./command-palette";
import { HeyoLogo } from "./logo";

/**
 * The frame: who you are, what there is, and the way into all of it.
 *
 * `Sidebar` is heyo-ui's, which buys three things this panel would otherwise
 * have had to write: ⌘B collapses it to a rail of icons, it turns into an
 * overlay drawer below 768px, and it shares the page background with a single
 * hairline between — a sidebar that is lighter than the page reads as a
 * floating panel, which is the busyness the design avoids.
 *
 * The navigation is generated from `GET /panel` like everything else, so a
 * collection added to the configuration appears in the sidebar without a
 * deploy of the panel. Content and Globals are sections you can fold away:
 * a deployment with forty collections otherwise pushes Media, Trash and
 * Settings off the bottom of the rail, and what you fold is remembered for
 * the tab.
 *
 * Three things are deliberately **not** here. There is no collapse button —
 * the page bar has one at the trail's level, and two triggers for one piece
 * of state is one too many. There is no deployment name beside the mark: the
 * trail already opens with it on the dashboard, and a sidebar header is not
 * where you learn which project you are in. And the search is not an input,
 * because there is nothing to type into here — it is a button shaped like
 * one, opening the palette that does the searching.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { config, session, signOut, theme, toggleTheme } = usePanel();
  const { path } = useRouter();
  const assistant = useAssistant();
  const [searching, setSearching] = useState(false);
  const [closed, setClosed] = useState<string[]>([]);
  const [, section, slug, id] = path.split("/");
  const documentScreen =
    section === "c" &&
    !!id &&
    config.collections.some((collection) => collection.slug === slug);

  const groups = new Map<string, typeof config.collections>();
  for (const collection of config.collections) {
    const key = collection.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), collection]);
  }

  const name =
    session.user?.name ?? session.user?.email ?? session.actor?.id ?? "Account";
  const email = session.user?.email ?? session.actor?.id ?? null;

  // One role on the line, the rest counted: an actor with four roles would
  // otherwise wrap the header onto a second row, which is the one thing a
  // menu header must not do.
  const roles = session.actor?.roles ?? [];
  const role =
    roles.length > 1 ? `${roles[0]} +${roles.length - 1}` : (roles[0] ?? null);
  const roleTitle = roles.length > 1 ? roles.join(", ") : null;

  const toggleGroup = (label: string, open: boolean) =>
    setClosed((current) =>
      open ? current.filter((entry) => entry !== label) : [...current, label],
    );

  return (
    <Sidebar.Provider>
      <Sidebar collapsible="icon">
        <Sidebar.Header className="gap-0 p-0">
          {/*
           * `h-12`, which is `PageBar`'s height, and the hairline under it is
           * the bar's own rule carried across the seam: the mark and the trail
           * sit on one line, and the navigation starts where the page content
           * starts. The row is padded like a menu row (`px-2.5`), so the mark
           * shares the vertical axis of every icon underneath it.
           */}
          <div className="flex h-12 shrink-0 items-center border-b border-heyo-hairline px-2.5">
            <Link
              to="/"
              aria-label={config.title}
              title={config.title}
              className="flex h-8 items-center rounded-md heyo-focus"
            >
              <HeyoLogo className="h-6 w-auto shrink-0 text-heyo-strong" />
            </Link>
          </div>

          <div className="flex flex-col gap-2 p-2">
            <SidebarSearch
              onOpen={() => setSearching(true)}
              assistantOpen={assistant.open}
              onToggleAssistant={() => assistant.setOpen(!assistant.open)}
            />
          </div>
        </Sidebar.Header>

        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                icon={IconHome}
                active={path === "/"}
                render={<Link to="/" />}
              >
                Home
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>

          {[...groups.entries()].map(([group, collections]) => {
            const label = group || "Content";
            return (
              <Sidebar.Group key={group}>
                <Sidebar.Menu>
                  <Sidebar.MenuItem>
                    <Sidebar.Collapsible
                      open={!closed.includes(label)}
                      onOpenChange={(open) => toggleGroup(label, open)}
                    >
                      <Sidebar.CollapsibleTrigger
                        render={
                          <Sidebar.MenuButton unwrapped icon={IconFolder}>
                            {label}
                            <Sidebar.MenuBadge>
                              {collections.length}
                            </Sidebar.MenuBadge>
                            <Sidebar.MenuChevron />
                          </Sidebar.MenuButton>
                        }
                      />
                      <Sidebar.CollapsibleContent>
                        <Sidebar.MenuSub>
                          {collections.map((collection) => (
                            <Sidebar.MenuSubButton
                              key={collection.slug}
                              active={path.startsWith(`/c/${collection.slug}`)}
                              render={<Link to={`/c/${collection.slug}`} />}
                            >
                              {collection.label}
                            </Sidebar.MenuSubButton>
                          ))}
                        </Sidebar.MenuSub>
                      </Sidebar.CollapsibleContent>
                    </Sidebar.Collapsible>
                  </Sidebar.MenuItem>
                </Sidebar.Menu>
              </Sidebar.Group>
            );
          })}

          {config.globals.length > 0 ? (
            <Sidebar.Group>
              <Sidebar.Menu>
                <Sidebar.MenuItem>
                  <Sidebar.Collapsible
                    open={!closed.includes("Globals")}
                    onOpenChange={(open) => toggleGroup("Globals", open)}
                  >
                    <Sidebar.CollapsibleTrigger
                      render={
                        <Sidebar.MenuButton unwrapped icon={IconWorld}>
                          Globals
                          <Sidebar.MenuBadge>
                            {config.globals.length}
                          </Sidebar.MenuBadge>
                          <Sidebar.MenuChevron />
                        </Sidebar.MenuButton>
                      }
                    />
                    <Sidebar.CollapsibleContent>
                      <Sidebar.MenuSub>
                        {config.globals.map((global) => (
                          <Sidebar.MenuSubButton
                            key={global.slug}
                            active={path === `/g/${global.slug}`}
                            render={<Link to={`/g/${global.slug}`} />}
                          >
                            {global.label}
                          </Sidebar.MenuSubButton>
                        ))}
                      </Sidebar.MenuSub>
                    </Sidebar.CollapsibleContent>
                  </Sidebar.Collapsible>
                </Sidebar.MenuItem>
              </Sidebar.Menu>
            </Sidebar.Group>
          ) : null}

          {/* Flat, and not foldable: three rows that are always the same
              three rows are a place, not a section. */}
          <Sidebar.Group>
            <Sidebar.GroupLabel>Library</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {config.media.enabled ? (
                <Sidebar.MenuButton
                  icon={IconPhoto}
                  active={path.startsWith("/media")}
                  render={<Link to="/media" />}
                >
                  Media
                </Sidebar.MenuButton>
              ) : null}
              {config.trash.enabled ? (
                <Sidebar.MenuButton
                  icon={IconTrash}
                  active={path.startsWith("/trash")}
                  render={<Link to="/trash" />}
                >
                  Trash
                </Sidebar.MenuButton>
              ) : null}
              <Sidebar.MenuButton
                icon={IconSettings}
                active={path.startsWith("/settings")}
                render={<Link to="/settings" />}
              >
                Settings
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>

        <Sidebar.Footer>
          <Sidebar.Menu>
            <Sidebar.MenuItem>
              <Dropdown>
                {/*
                 * Not `Sidebar.MenuButton`: its icon slot is a 16px box and
                 * it clones whatever goes in with `size-full`, so an avatar
                 * passed there came out shrunk and sitting off the text's
                 * centre line, and passing it as a child instead puts it
                 * inside the truncating label span where the row's gap does
                 * not apply. The row is twelve lines of its own instead,
                 * with the avatar on the same vertical axis as every icon
                 * above it: `px-1.5` + half of 24px is the `px-2.5` + half
                 * of 16px the navigation rows use.
                 */}
                <Dropdown.Trigger
                  render={
                    <button
                      type="button"
                      aria-label="Account"
                      className={cn(
                        "flex h-10 w-full min-w-0 cursor-pointer items-center gap-2.5",
                        "rounded-lg px-1.5 text-left heyo-focus",
                        "transition-colors duration-100 ease-heyo hover:bg-heyo-tint",
                        "group-data-[state=collapsed]/sidebar:justify-center",
                        "group-data-[state=collapsed]/sidebar:px-0",
                      )}
                    >
                      <Avatar
                        name={name}
                        size="sm"
                        className="shrink-0"
                        {...(session.user?.avatarUrl
                          ? { src: session.user.avatarUrl }
                          : {})}
                      />
                      <span className="flex min-w-0 flex-1 flex-col group-data-[state=collapsed]/sidebar:hidden">
                        <span className="truncate text-sm text-heyo-strong">
                          {name}
                        </span>
                        {email && email !== name ? (
                          <span className="truncate text-xs text-heyo-subtle">
                            {email}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  }
                />
                <Dropdown.Content side="top" align="start" className="w-60">
                  {/*
                   * One line, always: who is signed in on the left, the
                   * role on the right, both centred on the same baseline.
                   * A long address truncates rather than wrapping the role
                   * onto a second row — a header that changes height with
                   * the length of an email moves the menu under the cursor.
                   */}
                  <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
                    <span
                      title={email ?? name}
                      className="min-w-0 flex-1 truncate text-xs text-heyo-subtle"
                    >
                      {email ?? name}
                    </span>
                    {role ? (
                      <Badge
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        {...(roleTitle ? { title: roleTitle } : {})}
                      >
                        {role}
                      </Badge>
                    ) : null}
                  </div>
                  <Dropdown.Separator />
                  <Dropdown.Item
                    icon={theme === "dark" ? IconSun : IconMoon}
                    onClick={toggleTheme}
                  >
                    {theme === "dark" ? "Light mode" : "Dark mode"}
                  </Dropdown.Item>
                  <Dropdown.Item
                    icon={IconSettings}
                    render={<Link to="/settings" />}
                  >
                    Settings
                  </Dropdown.Item>
                  <Dropdown.Separator />
                  <Dropdown.Item
                    destructive
                    icon={IconLogout}
                    onClick={() => void signOut()}
                  >
                    Sign out
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown>
            </Sidebar.MenuItem>
          </Sidebar.Menu>
        </Sidebar.Footer>

        {/* No `Sidebar.Rail` either: the seam is a third way to collapse the
            thing, and one — the trigger in the page bar — is enough. */}
      </Sidebar>

      <Sidebar.Inset
        className={cn(
          "h-svh min-w-0 overflow-hidden",
          // The gutter opens at the drawer's pace and on its easing, so the
          // page moves *with* the drawer rather than snapping aside a frame
          // before it arrives — the same clock the sidebar folds on.
          "transition-[margin,padding] duration-(--heyo-sidebar-duration) ease-heyo",
          "motion-reduce:transition-none",
          // The closed composer sits 1rem above the viewport bottom and is
          // 2.5rem tall. End the page's scrollport above it (with a little
          // breathing room) so the last row or button stays reachable. The
          // document editor owns its own full-height writing layout instead.
          !assistant.open && !documentScreen && "pb-20",
          // Room for the open drawer, so the page is still fully readable
          // next to it rather than half-covered by it. On a narrow screen the
          // drawer takes the width and the page waits behind it.
          //
          // `max-md:hidden` rather than `hidden md:block`: the second one
          // swapped the inset from `flex` to `block` on wide screens too, and
          // `display` does not transition — the whole column relaid out in
          // one frame underneath a margin that was still animating, which is
          // the jolt the editor made every time the drawer opened.
          assistant.open && "max-md:hidden md:mr-[24rem]",
        )}
      >
        {children}
      </Sidebar.Inset>

      {/*
       * Once, here, and not in a screen. The conversation lives above the
       * router (see `AssistantProvider`), and rendering its surface per screen
       * would unmount the composer on every navigation — including the ones
       * the assistant itself suggests.
       */}
      <AiAssistant />

      <CommandPalette open={searching} onOpenChange={setSearching} />
    </Sidebar.Provider>
  );
}

/**
 * The search affordance, which is heyo-ui's field chrome around a button.
 *
 * A read-only input would be the wrong element twice: a text field is always
 * treated as keyboard-focused, so returning focus to it after the palette
 * closes parks a focus ring on a control that was only clicked, and there is
 * no query here to hold anyway. `Command.Shortcut` spells the chord for the
 * platform — ⌘K on a Mac, Ctrl K everywhere else — pinned to the right edge
 * where every shortcut hint in the system sits.
 */
function SidebarSearch({
  onOpen,
  assistantOpen,
  onToggleAssistant,
}: {
  onOpen: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
}) {
  // One button, one piece of state: the control that opened the assistant is
  // the control that closes it. A button that only ever opens leaves the
  // panel's single conversational surface with no visible way out of it.
  const assistantLabel = assistantOpen
    ? "Close AI assistant"
    : "Open AI assistant";

  return (
    <>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          "group-data-[state=collapsed]/sidebar:hidden",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            controlTriggerBase,
            controlSizeVariants({ size: "base" }),
            // `text-sm`, not the control's own 14px: this row lives among
            // the 13px navigation rows, not among the forms.
            "flex flex-1 cursor-pointer items-center gap-2 text-left text-sm text-heyo-subtle",
            "hover:bg-heyo-control-hover hover:text-heyo-default",
          )}
        >
          <IconSearch className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Search</span>
          <Command.Shortcut keys="mod+k" className="ml-auto shrink-0" />
        </button>
        <Button
          size="base"
          shape="square"
          variant={assistantOpen ? "secondary" : "outline"}
          icon={IconSparkles}
          aria-label={assistantLabel}
          aria-expanded={assistantOpen}
          onClick={onToggleAssistant}
        />
      </div>

      {/* The rail has 3.25rem to work with, which is the icon and nothing
          else. Keep both entry points available after the sidebar collapses. */}
      <Sidebar.MenuButton
        unwrapped
        icon={IconSearch}
        aria-label="Search"
        onClick={onOpen}
        className={cn(
          "hidden text-heyo-subtle",
          "group-data-[state=collapsed]/sidebar:flex",
        )}
      />
      <Sidebar.MenuButton
        unwrapped
        icon={IconSparkles}
        aria-label={assistantLabel}
        aria-expanded={assistantOpen}
        active={assistantOpen}
        onClick={onToggleAssistant}
        className={cn(
          "hidden text-heyo-subtle",
          "group-data-[state=collapsed]/sidebar:flex",
        )}
      />
    </>
  );
}
