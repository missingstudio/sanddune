import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseEnvFile, resolveEnv } from "./env-resolver";

describe("resolveEnv (declaration-driven, ADR-0012)", () => {
  let tmp: string;
  let envPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sanddune-env-"));
    await mkdir(join(tmp, ".sanddune"), { recursive: true });
    envPath = join(tmp, ".sanddune", ".env");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("missing .sanddune/.env and no provider env yields an empty map", async () => {
    const env = await resolveEnv({
      processEnv: { ANYTHING: "leak-attempt" },
      sandduneEnvPath: envPath,
    });
    expect(env).toEqual({});
  });

  test("a key declared in .sanddune/.env with a literal value uses that value", async () => {
    await writeFile(envPath, "ANTHROPIC_API_KEY=sk-from-file\n");
    const env = await resolveEnv({
      processEnv: { ANTHROPIC_API_KEY: "sk-from-process" },
      sandduneEnvPath: envPath,
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-from-file");
  });

  test("a key declared in .sanddune/.env with empty RHS falls through to process.env", async () => {
    await writeFile(envPath, "ANTHROPIC_API_KEY=\n");
    const env = await resolveEnv({
      processEnv: { ANTHROPIC_API_KEY: "sk-from-process" },
      sandduneEnvPath: envPath,
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-from-process");
  });

  test("host shell vars do not leak unless declared", async () => {
    const env = await resolveEnv({
      processEnv: {
        HOME: "/Users/me",
        PATH: "/opt/homebrew/bin",
        USER: "me",
        PWD: "/Users/me/proj",
        TERM_PROGRAM: "iTerm.app",
        SHLVL: "2",
        ANTHROPIC_API_KEY: "sk-from-process",
      },
      sandduneEnvPath: envPath,
    });
    expect(env["HOME"]).toBeUndefined();
    expect(env["PATH"]).toBeUndefined();
    expect(env["USER"]).toBeUndefined();
    expect(env["PWD"]).toBeUndefined();
    expect(env["TERM_PROGRAM"]).toBeUndefined();
    expect(env["SHLVL"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  test("agent provider env declares + supplies value", async () => {
    const env = await resolveEnv({
      processEnv: {},
      sandduneEnvPath: envPath,
      agentEnv: { ANTHROPIC_API_KEY: "from-agent" },
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("from-agent");
  });

  test("sandbox provider env declares + supplies value", async () => {
    const env = await resolveEnv({
      processEnv: {},
      sandduneEnvPath: envPath,
      sandboxEnv: { VERCEL_TOKEN: "from-sandbox" },
    });
    expect(env["VERCEL_TOKEN"]).toBe("from-sandbox");
  });

  test("RunOptions.env declares + supplies value", async () => {
    const env = await resolveEnv({
      processEnv: {},
      sandduneEnvPath: envPath,
      runOptionsEnv: { CUSTOM: "from-call" },
    });
    expect(env["CUSTOM"]).toBe("from-call");
  });

  test("precedence: runOptions > agent > sandbox > file > process", async () => {
    await writeFile(envPath, "K=from-file\n");
    const env = await resolveEnv({
      processEnv: { K: "from-process" },
      sandduneEnvPath: envPath,
      agentEnv: { K: "from-agent" },
      runOptionsEnv: { K: "from-run-options" },
    });
    expect(env["K"]).toBe("from-run-options");
  });

  test("precedence: agent over file when runOptions absent", async () => {
    await writeFile(envPath, "K=from-file\n");
    const env = await resolveEnv({
      processEnv: { K: "from-process" },
      sandduneEnvPath: envPath,
      agentEnv: { K: "from-agent" },
    });
    expect(env["K"]).toBe("from-agent");
  });

  test("precedence: sandbox over file when agent and runOptions absent", async () => {
    await writeFile(envPath, "K=from-file\n");
    const env = await resolveEnv({
      processEnv: { K: "from-process" },
      sandduneEnvPath: envPath,
      sandboxEnv: { K: "from-sandbox" },
    });
    expect(env["K"]).toBe("from-sandbox");
  });

  test("precedence: file over process", async () => {
    await writeFile(envPath, "K=from-file\n");
    const env = await resolveEnv({
      processEnv: { K: "from-process" },
      sandduneEnvPath: envPath,
    });
    expect(env["K"]).toBe("from-file");
  });

  test("declared-but-no-value-anywhere drops the key", async () => {
    await writeFile(envPath, "MISSING=\n");
    const env = await resolveEnv({
      processEnv: {}, // no fallback value
      sandduneEnvPath: envPath,
    });
    expect("MISSING" in env).toBe(false);
  });

  test("rejects overlapping keys between agent and sandbox env", async () => {
    await expect(
      resolveEnv({
        processEnv: {},
        sandduneEnvPath: envPath,
        agentEnv: { SHARED: "agent" },
        sandboxEnv: { SHARED: "sandbox" },
      }),
    ).rejects.toThrow(/SHARED/);
  });

  test("RunOptions.env may overlap with agent env (it's the escape hatch)", async () => {
    const env = await resolveEnv({
      processEnv: {},
      sandduneEnvPath: envPath,
      agentEnv: { ANTHROPIC_API_KEY: "from-agent" },
      runOptionsEnv: { ANTHROPIC_API_KEY: "from-run-options" },
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("from-run-options");
  });
});

describe("parseEnvFile", () => {
  let tmp: string;
  let path: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sanddune-env-parse-"));
    path = join(tmp, ".env");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("missing file yields empty object", async () => {
    expect(await parseEnvFile(path)).toEqual({});
  });

  test("parses simple KEY=value", async () => {
    await writeFile(path, "FOO=bar\nBAZ=qux\n");
    expect(await parseEnvFile(path)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips matching surrounding quotes", async () => {
    await writeFile(path, `A="double"\nB='single'\n`);
    expect(await parseEnvFile(path)).toEqual({ A: "double", B: "single" });
  });

  test("preserves mismatched quotes", async () => {
    await writeFile(path, `A="not-closed\nB='also"weird'\n`);
    const out = await parseEnvFile(path);
    expect(out["A"]).toBe(`"not-closed`);
    expect(out["B"]).toBe(`also"weird`); // outer single quotes stripped
  });

  test("ignores comments and blank lines", async () => {
    await writeFile(path, "# header\n\nFOO=bar\n# inline-style not removed\n");
    expect(await parseEnvFile(path)).toEqual({ FOO: "bar" });
  });

  test("preserves equals signs in values", async () => {
    await writeFile(path, "TOKEN=a=b=c\n");
    expect(await parseEnvFile(path)).toEqual({ TOKEN: "a=b=c" });
  });

  test("KEY= produces an empty string (declared, no value)", async () => {
    await writeFile(path, "EMPTY=\n");
    expect(await parseEnvFile(path)).toEqual({ EMPTY: "" });
  });

  test("rejects lines without = sign", async () => {
    await writeFile(path, "GOOD=yes\nbroken-line\n");
    expect(await parseEnvFile(path)).toEqual({ GOOD: "yes" });
  });
});
