export interface Timeouts {
  readonly idleSeconds?: number;
  readonly totalSeconds?: number;
  /** user-supplied lifecycle steps are caller-configurable. */
  readonly copyToWorktreeMs?: number;
}
