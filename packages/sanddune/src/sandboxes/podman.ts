import {
  NotImplementedError,
  type BindMountSandboxProvider,
} from "@missingstudio/sanddune-core";

export interface PodmanOptions {
  readonly image?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export function podman(_options?: PodmanOptions): BindMountSandboxProvider {
  throw new NotImplementedError("podman");
}
