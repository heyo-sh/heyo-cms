import {
  REST_GET,
  REST_POST,
  REST_PATCH,
  REST_DELETE,
  REST_PUT,
  REST_OPTIONS,
} from "@payloadcms/next/routes";
import config from "../../../payload.config.mjs";

export const GET = REST_GET(config);
export const POST = REST_POST(config);
export const PATCH = REST_PATCH(config);
export const PUT = REST_PUT(config);
export const DELETE = REST_DELETE(config);
export const OPTIONS = REST_OPTIONS(config);
