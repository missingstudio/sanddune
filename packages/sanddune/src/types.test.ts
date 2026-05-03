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
import type { Worktree } from "./core";
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

  // interactive() accepts no prompt at all — the TUI launches bare.
  void interactive({
    agent: agentStub,
    sandbox: noSandboxStub,
  });

  // interactive() does not accept branchStrategy (top-level uses provider
  // default; route through createWorktree() + wt.interactive() for non-default).
  void interactive({
    agent: agentStub,
    sandbox: bindMountStub,
    // @ts-expect-error branchStrategy is not accepted by top-level interactive()
    branchStrategy: { type: "merge-to-head" },
  });

  // interactive() does not accept maxIterations / completionSignal — those
  // are iteration-loop concerns; interactive sessions are user-driven.
  void interactive({
    agent: agentStub,
    sandbox: noSandboxStub,
    // @ts-expect-error maxIterations is not part of InteractiveOptions
    maxIterations: 5,
  });
  void interactive({
    agent: agentStub,
    sandbox: noSandboxStub,
    // @ts-expect-error completionSignal is not part of InteractiveOptions
    completionSignal: "DONE",
  });

  // wt.interactive() defaults to noSandbox() — sandbox is optional.
  const wtStub = null as unknown as Worktree;
  void wtStub.interactive({ agent: agentStub });
  void wtStub.interactive({ agent: agentStub, prompt: "x" });
  void wtStub.interactive({
    agent: agentStub,
    sandbox: bindMountStub,
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
