/** Host environment variables that are shell- or session-specific and would
 *  break the sandbox if propagated. Filtered out of the host's `process.env`
 *  before merging with provider env.
 *
 *  Concrete failures avoided:
 *  - `HOME=/Users/...` → shadows the container's `~/.gitconfig`, breaking
 *    `git commit` because `user.email` / `user.name` aren't found.
 *  - `PATH=/opt/homebrew/...` → points at host paths that don't exist in the
 *    container; agent binaries (e.g. `claude`) can't be found.
 *  - `PWD`, `OLDPWD`, `SHLVL`, `_` → leak the host shell's session state.
 *  - `TERM_PROGRAM`, `COLORTERM`, `ITERM_*` → terminal-emulator-specific.
 *
 *  Provider env (`agentEnv`, `sandboxEnv`) and `RunOptions.env` (future)
 *  bypass this filter, since callers explicitly opt in to those keys.
 *
 *  ASSUMPTION: this list is correct for **bind-mount** and **isolated**
 *  sandbox providers, where the sandbox has its own filesystem layout and
 *  shell environment. For the **no-sandbox provider** (#18), the agent runs
 *  directly on the host, so HOME/PATH/USER from `process.env` are exactly
 *  what's wanted. When that provider lands, env policy should move from a
 *  global blocklist to a per-provider declaration — see the architecture
 *  notes for the suggested seam. */
const HOST_ONLY_ENV_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "SHLVL",
  "_",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "ITERM_PROFILE",
  "ITERM_SESSION_ID",
  "__CFBundleIdentifier",
  "XPC_SERVICE_NAME",
  "XPC_FLAGS",
  "COMMAND_MODE",
]);

export function resolveEnv(params: {
  readonly processEnv: NodeJS.ProcessEnv;
  readonly agentEnv?: Readonly<Record<string, string>>;
  readonly sandboxEnv?: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  const agent = params.agentEnv ?? {};
  const sandbox = params.sandboxEnv ?? {};
  const overlap = Object.keys(agent).filter((key) => key in sandbox);
  if (overlap.length > 0) {
    throw new Error(
      `Agent provider env and sandbox provider env must not overlap. Conflicting keys: ${overlap.join(", ")}`,
    );
  }

  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.processEnv)) {
    if (typeof value !== "string") continue;
    if (HOST_ONLY_ENV_KEYS.has(key)) continue;
    merged[key] = value;
  }

  for (const [key, value] of Object.entries(agent)) merged[key] = value;
  for (const [key, value] of Object.entries(sandbox)) merged[key] = value;
  return merged;
}
