export type AgentStreamEvent =
  | {
      readonly type: "text";
      readonly content: string;
      readonly iteration: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "toolCall";
      readonly name: string;
      readonly input: unknown;
      readonly iteration: number;
      readonly timestamp: number;
    };

export interface AgentBuildCommandInput {
  readonly prompt: string;
  readonly iteration: number;
  /** When set, the **agent provider** appends provider-specific resume args
   *  (e.g. Claude Code's `--resume <id>`). Forwarded by the **agent invoker**
   *  on iteration 1 only when `RunOptions.resumeSession` is set; `undefined`
   *  on every other turn. Providers without resume support ignore it. */
  readonly resumeSessionId?: string;
}

/** Agent-specific glue for **agent session** capture and resume. Optional;
 *  agents that have no concept of a resumable session simply omit it and
 *  capture/resume become no-ops at the run-program level.
 *
 *  All paths returned are absolute strings that can be passed to
 *  `BindMountSandboxHandle.exec` (host paths are absolute filesystem paths;
 *  sandbox paths may begin with `~` since they are evaluated by the sandbox
 *  shell). `rewriteCwd` operates on the JSONL text — one record per line —
 *  and is responsible for replacing every entry's `cwd` field from
 *  `fromCwd` to `toCwd` while leaving the rest of the record intact. */
export interface AgentSessionCapture {
  /** Inspect a raw stream line and return the **agent session** id it
   *  carries, if any. The first non-undefined return wins for an iteration —
   *  the **agent invoker** stops calling once it has an id. */
  parseSessionId(line: string): string | undefined;
  /** Where the captured JSONL is written on the **host**. */
  hostSessionPath(hostCwd: string, sessionId: string): string;
  /** Where the **agent** writes the JSONL inside the **sandbox** (the file
   *  the **iteration loop** reads back to capture, and the file resume
   *  transfers in to). May begin with `~`. */
  sandboxSessionPath(sandboxCwd: string, sessionId: string): string;
  /** Rewrite all `cwd` fields in the JSONL from `fromCwd` to `toCwd`. */
  rewriteCwd(jsonl: string, fromCwd: string, toCwd: string): string;
}

export interface AgentProvider {
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Optional **agent session** capture/resume capability. Present iff the
   *  agent supports it AND the user has not opted out (e.g.
   *  `claudeCode({ captureSessions: false })`). Absent → capture and
   *  `resumeSession` become no-ops; `resumeSession` is silently ignored
   *  rather than rejected, mirroring the brief / CONTEXT.md. */
  readonly sessionCapture?: AgentSessionCapture;
  buildCommand(input: AgentBuildCommandInput): string;
  parseLine(line: string, iteration: number): readonly AgentStreamEvent[];
}
