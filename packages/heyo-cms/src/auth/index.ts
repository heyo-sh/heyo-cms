/**
 * Editor authentication: configuration builders and the runtime behind
 * `cms.auth`.
 *
 * The CMS has accounts for the people who edit content and for the machines
 * that call its API, and for nobody else — the application being built brings
 * its own identity layer (section 0). Everything here is Web Crypto and the
 * database adapter, so the same sign-in works on Node, Bun and Workers.
 */
export { cmsUsers, oidc, type CmsUsersOptions, type OidcOptions } from "./config"; // prettier-ignore
export {
  apiKeyPrefix,
  createAuth,
  sessionCookieName,
  type AuthServiceOptions,
} from "./service";
export {
  base64url,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
} from "./crypto";
export { generateTotpSecret, totpCode, totpUri, verifyTotp } from "./totp";
export {
  builtinProviders,
  decodeIdToken,
  type OAuthProfile,
  type OAuthProvider,
} from "./oauth";
