import {
  NotImplementedError,
  type IsolatedSandboxProvider,
} from "../core";

export interface VercelOptions {
  readonly image?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export function vercel(_options?: VercelOptions): IsolatedSandboxProvider {
  throw new NotImplementedError("vercel");
}
