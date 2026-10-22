/**
 * `@heyo-sh/heyo-cms/uploads`.
 *
 * Storage adapters, the image processor contract, and the two pieces of image
 * work the engine does without a codec. Separate from the main entry point so
 * a Worker bundle that never touches a file does not carry any of it.
 *
 * The lifecycle itself — reference counting, orphaning, collection — is not
 * here: it is part of the engine, because it happens inside the transaction
 * that saves a document (section 6).
 */

export { local, memory } from "./storage/local";
export type { LocalStorageOptions, MemoryStorageOptions } from "./storage/local"; // prettier-ignore
export {
  azure,
  gcs,
  r2,
  s3,
  type AzureStorageOptions,
  type GcsStorageOptions,
  type R2Binding,
  type R2StorageOptions,
  type S3StorageOptions,
} from "./storage/providers";
export {
  encodeKey,
  httpStorage,
  type FetchLike,
  type HttpStorageOptions,
  type SignableRequest,
} from "./storage/http";
export {
  signAwsV4,
  signAzure,
  type AwsCredentials,
  type AwsSignRequest,
  type AzureSignRequest,
} from "./storage/sign";
export { sharpImages, type SharpImagesOptions } from "./media/sharp";
export {
  extensionFor,
  imageContentType,
  probeImage,
  stripImageMetadata,
} from "./media/index";

export type {
  ObjectMeta,
  SignedUrlOptions,
  StorageAdapter,
  StorageAdapterFactory,
  StorageConfig,
  StoredObject,
} from "./types/storage";
export type {
  CropRect,
  FocalPoint,
  ImageFormat,
  ImageInfo,
  ImageProcessor,
  ImageTransform,
  MediaDocument,
  MediaStatus,
  MediaUsage,
  ProcessedImage,
} from "./types/media";
