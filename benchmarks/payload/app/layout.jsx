import { RootLayout, handleServerFunctions } from "@payloadcms/next/layouts";
import "@payloadcms/next/css";
import config from "../payload.config.mjs";

const importMap = {};
const serverFunction = async (args) => {
  "use server";
  return handleServerFunctions({ ...args, config, importMap });
};
export default function Layout({ children }) {
  return (
    <RootLayout
      config={config}
      importMap={importMap}
      serverFunction={serverFunction}
    >
      {children}
    </RootLayout>
  );
}
