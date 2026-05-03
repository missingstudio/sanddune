import {
  NotImplementedError,
  type NoSandboxProvider,
} from "../core";

export interface NoSandboxOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export function noSandbox(_options?: NoSandboxOptions): NoSandboxProvider {
  throw new NotImplementedError("noSandbox");
}
