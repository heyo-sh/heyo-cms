/**
 * Media: storage, processing and the lifecycle.
 *
 * Three separate concerns that only make sense together. Storage is where the
 * bytes live; processing is what happens to them on the way in and on the way
 * out; the lifecycle is the reference counting that lets a file be removed
 * from a page without being destroyed (section 6).
 *
 * Nothing here is HTTP-aware. The routes in stage 7 and the library screen in
 * stage 8 call exactly these functions.
 */
export { mediaJson, reservedMetadata, toMediaDocument } from "./document";
export {
  collectMedia,
  collectOne,
  dueMedia,
  mediaGcJob,
  storageKeysOf,
  type CollectOutcome,
  type MediaGcContext,
} from "./gc";
export {
  matchesMime,
  prepareUpload,
  sanitiseFilename,
  type PrepareUploadOptions,
  type PreparedUpload,
} from "./pipeline";
export { extensionFor, imageContentType, probeImage } from "./probe";
export { createMedia, type MediaServiceOptions } from "./service";
export { stripImageMetadata } from "./strip";
export {
  collectMediaReferences,
  mediaTable,
  mediaUsagesTable,
  purgeDeadline,
  referencesMedia,
  richTextMediaAttribute,
  syncMediaUsages,
  type MediaReference,
  type SyncMediaUsagesOptions,
  type SyncMediaUsagesResult,
} from "./usages";
export {
  renderVariant,
  variantContentType,
  variantKey,
  variantNames,
  variantQuery,
  variantSize,
  variantTransform,
} from "./variants";
