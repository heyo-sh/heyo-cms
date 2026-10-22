import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("posts/:handle", "routes/posts.$handle.tsx"),
  // One splat route for the entire CMS, and one for the platform cron.
  route("api/heyo-cms/*", "routes/api.heyo-cms.$.ts"),
  route("api/cron", "routes/api.cron.ts"),
] satisfies RouteConfig;
