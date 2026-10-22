import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { platformPlugins, platformSsr } from "./platform.vite.ts";

export default defineConfig({
  plugins: [...platformPlugins, reactRouter(), tailwindcss()],
  ssr: platformSsr,
});
