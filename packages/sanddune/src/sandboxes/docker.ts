import {
  NotImplementedError,
  type BindMountSandboxProvider,
} from "@missingstudio/sanddune-core";

export interface DockerOptions {
  readonly image?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export function docker(_options?: DockerOptions): BindMountSandboxProvider {
  throw new NotImplementedError("docker");
}
