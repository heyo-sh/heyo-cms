import { withPayload } from "@payloadcms/next/withPayload";

export default withPayload({
  turbopack: {
    resolveAlias: { "@payload-config": "./payload.config.mjs" },
  },
});
