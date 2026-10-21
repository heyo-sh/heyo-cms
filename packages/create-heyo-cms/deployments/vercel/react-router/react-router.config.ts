import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

/**
 * Server rendering on Vercel Functions.
 *
 * The preset is what turns the React Router build into the output Vercel
 * expects; nothing is prerendered, because a page showing yesterday's content
 * would make the panel look broken.
 */
export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
