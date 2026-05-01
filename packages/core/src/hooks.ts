export interface HostHook {
  readonly command: string;
}

export interface SandboxHook {
  readonly command: string;
  readonly sudo?: boolean;
}

export interface HostHooks {
  readonly onWorktreeReady?: HostHook | readonly HostHook[];
  readonly onSandboxReady?: HostHook | readonly HostHook[];
}

export interface InSandboxHooks {
  readonly onSandboxReady?: SandboxHook | readonly SandboxHook[];
}

export interface SandboxHooks {
  readonly host?: HostHooks;
  readonly sandbox?: InSandboxHooks;
}
