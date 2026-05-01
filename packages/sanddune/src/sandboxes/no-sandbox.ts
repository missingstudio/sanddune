import {
  NotImplementedError,
  type NoSandboxProvider,
} from "@missingstudio/sanddune-core";

export interface NoSandboxOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export function noSandbox(_options?: NoSandboxOptions): NoSandboxProvider {
  throw new NotImplementedError("noSandbox");
}
