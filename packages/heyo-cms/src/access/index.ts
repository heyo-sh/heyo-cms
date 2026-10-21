/**
 * Role-based access control.
 *
 * Pure string work, no database and no engine: the same functions decide an
 * actor's permissions when a session is created, when an API key is verified
 * and when an access rule asks a question inside a configuration file.
 */
export {
  expandRoles,
  grants,
  intersectPermissions,
  isValidScope,
  permissionFor,
  permits,
  scopePermissions,
  wildcard,
} from "./permissions";
