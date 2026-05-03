// The real assertions in this file are the @ts-expect-error directives inside
// _typeChecks. They're checked by `bun run typecheck`, not by `bun test` —
// the test runner only confirms the file loads. Removing this file from the
// typecheck flow would silently drop coverage of all six type-level
// rejections.
import { expect, test } from "bun:test";
import type {
  AgentProvider,
  BindMountSandboxProvider,
  IsolatedSandboxProvider,
  NoSandboxProvider,
} from "./core";
import type { Sandbox } from "./core";
import {
  createSandbox,
  createWorktree,
  interactive,
  run,
} from "./index";
import { docker } from "./sandboxes/docker";
import { noSandbox } from "./sandboxes/no-sandbox";
import { vercel } from "./sandboxes/vercel";

test("type-level rejections are compile errors (see _typeChecks)", () => {
  expect(typeof _typeChecks).toBe("function");
});

function _typeChecks() {
  // Stubs typed at the parameter type — never executed at runtime because
  // _typeChecks is never called.
  const agentStub = null as unknown as AgentProvider;
  const bindMountStub = null as unknown as BindMountSandboxProvider;
  const isolatedStub = null as unknown as IsolatedSandboxProvider;
  const noSandboxStub = null as unknown as NoSandboxProvider;

  void run({
    agent: agentStub,
    sandbox: vercel(),
    prompt: "x",
    // @ts-expect-error head branch strategy is not allowed with an isolated provider
    branchStrategy: { type: "head" },
  });

  void run({
    agent: agentStub,
    // @ts-expect-error noSandbox() is not allowed for run()
    sandbox: noSandbox(),
    prompt: "x",
  });

  void createSandbox({
    agent: agentStub,
    // @ts-expect-error noSandbox() is not allowed for createSandbox()
    sandbox: noSandbox(),
    branch: "feat/x",
  });

  void createWorktree({
    // @ts-expect-error head branch strategy is not allowed for createWorktree()
    branchStrategy: { type: "head" },
  });

  // @ts-expect-error prompt and promptFile are mutually exclusive
  void run({
    agent: agentStub,
    sandbox: docker(),
    prompt: "x",
    promptFile: "y",
  });

  // @ts-expect-error promptArgs is not allowed with an inline prompt
  void run({
    agent: agentStub,
    sandbox: docker(),
    prompt: "x",
    promptArgs: { K: "v" },
  });

  void interactive({
    agent: agentStub,
    sandbox: noSandboxStub,
    prompt: "x",
  });

  void run({
    agent: agentStub,
    sandbox: bindMountStub,
    prompt: "x",
    branchStrategy: { type: "head" },
  });

  void run({
    agent: agentStub,
    sandbox: bindMountStub,
    prompt: "x",
    branchStrategy: { type: "merge-to-head" },
  });

  void run({
    agent: agentStub,
    sandbox: isolatedStub,
    prompt: "x",
    branchStrategy: { type: "branch", branch: "feat/x" },
  });

  const sandboxStub = null as unknown as Sandbox;

  // @ts-expect-error sandbox.run() rejects resumeSession at the type level
  void sandboxStub.run({ prompt: "x", resumeSession: "abc" });
}

void _typeChecks;
