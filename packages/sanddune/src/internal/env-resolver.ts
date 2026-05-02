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
    if (typeof value === "string") merged[key] = value;
  }

  for (const [key, value] of Object.entries(agent)) merged[key] = value;
  for (const [key, value] of Object.entries(sandbox)) merged[key] = value;
  return merged;
}
