import { RootPage } from "@payloadcms/next/views";
import config from "../../../payload.config.mjs";

export const dynamic = "force-dynamic";
export default function Page({ params, searchParams }) {
  return RootPage({ config, importMap: {}, params, searchParams });
}
