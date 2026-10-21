/**
 * What `heyoCms({ telemetry })` accepts.
 *
 * The behaviour, and the list of everything that is ever sent, is documented
 * on the module that implements it: `@heyo-sh/heyo-cms/telemetry`. In short —
 * the CLI reports, a deployment never does, and `{ enabled: false }` here is
 * one of three ways to turn even that off.
 */
export interface TelemetryConfig {
  enabled?: boolean;
  /** For a self-hosted collector. */
  endpoint?: string;
}
