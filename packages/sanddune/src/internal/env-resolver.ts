import { readFile } from "node:fs/promises";

/** Per ADR-0012, env is **declaration-driven**: a key reaches the sandbox
 *  iff some declaration site claimed it. `process.env` only supplies values
 *  for already-declared keys.
 *
 *  Value precedence (highest wins):
 *      runOptionsEnv > agentEnv > sandboxEnv > .sanddune/.env > process.env
 *
 *  Keys with no value in any layer are dropped (not surfaced as ""). Agent
 *  and sandbox env must be disjoint — overlap throws. */
export interface ResolveEnvInput {
  readonly processEnv: NodeJS.ProcessEnv;
  /** Missing file is treated as an empty declaration set. */
  readonly sandduneEnvPath: string;
  readonly agentEnv?: Readonly<Record<string, string>>;
  readonly sandboxEnv?: Readonly<Record<string, string>>;
  readonly runOptionsEnv?: Readonly<Record<string, string>>;
}

export async function resolveEnv(
  input: ResolveEnvInput,
): Promise<Readonly<Record<string, string>>> {
  const fileEnv = await parseEnvFile(input.sandduneEnvPath);
  const agent = input.agentEnv ?? {};
  const sandbox = input.sandboxEnv ?? {};
  const runOptions = input.runOptionsEnv ?? {};

  const overlap = Object.keys(agent).filter((key) => key in sandbox);
  if (overlap.length > 0) {
    throw new Error(
      `Agent provider env and sandbox provider env must not overlap. Conflicting keys: ${overlap.join(", ")}`,
    );
  }

  const declared = new Set<string>([
    ...Object.keys(fileEnv),
    ...Object.keys(agent),
    ...Object.keys(sandbox),
    ...Object.keys(runOptions),
  ]);

  const resolved: Record<string, string> = {};
  for (const key of declared) {
    const value = pickValue(key, {
      runOptions,
      agent,
      sandbox,
      file: fileEnv,
      processEnv: input.processEnv,
    });
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

function pickValue(
  key: string,
  sources: {
    readonly runOptions: Readonly<Record<string, string>>;
    readonly agent: Readonly<Record<string, string>>;
    readonly sandbox: Readonly<Record<string, string>>;
    readonly file: Readonly<Record<string, string>>;
    readonly processEnv: NodeJS.ProcessEnv;
  },
): string | undefined {
  if (sources.runOptions[key] !== undefined) return sources.runOptions[key];
  if (sources.agent[key] !== undefined) return sources.agent[key];
  if (sources.sandbox[key] !== undefined) return sources.sandbox[key];
  // Empty string in `.sanddune/.env` means "declared, value comes from
  // process.env" — skip past the file value if it's empty so we fall through.
  const fileValue = sources.file[key];
  if (fileValue !== undefined && fileValue.length > 0) return fileValue;
  const processValue = sources.processEnv[key];
  if (typeof processValue === "string" && processValue.length > 0) {
    return processValue;
  }
  return undefined;
}

/** Parse a `.env` file: `KEY=value` lines, `#` comment support, surrounding
 *  quotes (single or double) stripped, blank lines tolerated. A key with an
 *  empty RHS (`KEY=`) is recorded with an empty string — interpreted by the
 *  resolver as "declared, value from process.env." Missing file → empty map. */
export async function parseEnvFile(
  filePath: string,
): Promise<Readonly<Record<string, string>>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
