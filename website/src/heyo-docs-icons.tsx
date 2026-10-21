import {
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconBook2,
  IconBrandGithub,
  IconBulb,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconCode,
  IconCopy,
  IconCornerDownLeft,
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconGitFork,
  IconInfoCircle,
  IconLogin2,
  IconMenu2,
  IconMessageChatbot,
  IconMoon,
  IconNews,
  IconPointer,
  IconSearch,
  IconStar,
  IconSun,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import type { IconSet } from "@heyo-sh/heyo-docs/types";

/**
 * Tabler, the same pack the panel and heyo-ui draw from — one icon set for
 * everything this project ships, so a chevron in the documentation is the
 * chevron in the CMS.
 *
 * This mapping is intentionally local to the generated application. Replace
 * it with another pack to change the built-in UI without bundling all packs.
 */
const tablerIconSet = {
  book: IconBook2,
  changelog: IconNews,
  code: IconCode,
  file: IconFileText,
  github: IconBrandGithub,
  globe: IconWorld,
  signIn: IconLogin2,
  chevronDown: IconChevronDown,
  chevronRight: IconChevronRight,
  arrowDown: IconArrowDown,
  arrowUp: IconArrowUp,
  arrowRight: IconArrowRight,
  close: IconX,
  cornerDownLeft: IconCornerDownLeft,
  menu: IconMenu2,
  search: IconSearch,
  sun: IconSun,
  moon: IconMoon,
  checkCircle: IconCircleCheck,
  check: IconCheck,
  closeCircle: IconCircleX,
  externalLink: IconExternalLink,
  folder: IconFolder,
  gitFork: IconGitFork,
  gitRepository: IconGitBranch,
  information: IconInfoCircle,
  lightbulb: IconBulb,
  copy: IconCopy,
  star: IconStar,
  bot: IconMessageChatbot,
  cursor: IconPointer,
  chat: IconMessageChatbot,
};

/**
 * A generated project can temporarily resolve the icon package and Heyo Docs
 * through distinct React type installations (notably with file dependencies).
 * The runtime contract is identical SVG props, so expose the local mapping as
 * the framework-neutral icon contract after keeping the imports tree-shakeable.
 */
export const iconSet = tablerIconSet as unknown as Required<IconSet>;
