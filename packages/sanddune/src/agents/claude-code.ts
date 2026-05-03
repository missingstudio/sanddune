import { homedir } from "node:os";
import type {
  AgentProvider,
  AgentSessionCapture,
  AgentStreamEvent,
  IterationUsage,
} from "../core";

export interface ClaudeCodeOptions {
  readonly env?: Readonly<Record<string, string>>;
  /** Capture each iteration's **agent session** JSONL from the **sandbox**
   *  to the **host** (default `true`). Set `false` to opt out — capture
   *  becomes a no-op and `IterationResult.sessionId` /
   *  `IterationResult.sessionFilePath` stay `undefined`. */
  readonly captureSessions?: boolean;
}

export function claudeCode(
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider {
  const captureSessions = options?.captureSessions ?? true;
  return {
    name: "claude-code",
    env: options?.env,
    ...(captureSessions && { sessionCapture: claudeCodeSessionCapture }),
    buildCommand: ({ prompt, resumeSessionId }) => {
      const args = [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        shellQuote(model),
        "--dangerously-skip-permissions",
      ];
      if (resumeSessionId !== undefined) {
        args.push("--resume", shellQuote(resumeSessionId));
      }
      args.push(shellQuote(prompt));
      return args.join(" ");
    },
    parseLine: (line, iteration) => parseClaudeCodeLine(line, iteration),
  };
}

function parseClaudeCodeLine(
  line: string,
  iteration: number,
): readonly AgentStreamEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];
  if (parsed.type !== "assistant") return [];

  const message = parsed["message"];
  if (!isRecord(message)) return [];

  const content = message["content"];
  if (!Array.isArray(content)) return [];

  const timestamp = Date.now();
  const events: AgentStreamEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      events.push({
        type: "text",
        content: block["text"],
        iteration,
        timestamp,
      });
    } else if (
      block["type"] === "tool_use" &&
      typeof block["name"] === "string"
    ) {
      events.push({
        type: "toolCall",
        name: block["name"],
        input: block["input"],
        iteration,
        timestamp,
      });
    }
  }
  return events;
}

/** Claude Code's on-disk path encoding: take the absolute path, replace every
 *  `/` with `-`. So `/Users/me/repo` becomes `-Users-me-repo`. Matches the
 *  layout under `~/.claude/projects/` that `claude --resume` reads from. */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/\//g, "-");
}

const claudeCodeSessionCapture: AgentSessionCapture = {
  parseSessionId(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    if (parsed.type !== "system" || parsed["subtype"] !== "init") {
      return undefined;
    }
    const id = parsed["session_id"];
    return typeof id === "string" && id.length > 0 ? id : undefined;
  },
  hostSessionPath(hostCwd, sessionId) {
    return `${homedir()}/.claude/projects/${encodeProjectDir(
      hostCwd,
    )}/sessions/${sessionId}.jsonl`;
  },
  sandboxSessionPath(sandboxCwd, sessionId) {
    return `~/.claude/projects/${encodeProjectDir(sandboxCwd)}/${sessionId}.jsonl`;
  },
  rewriteCwd(jsonl, fromCwd, toCwd) {
    const lines = jsonl.split("\n");
    return lines
      .map((line, idx) => {
        // Preserve a final trailing newline (split produces an empty tail).
        if (line.length === 0 && idx === lines.length - 1) return line;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Best-effort: leave malformed lines untouched.
          return line;
        }
        if (!isRecord(parsed)) return line;
        if (parsed["cwd"] !== fromCwd) return line;
        return JSON.stringify({ ...parsed, cwd: toCwd });
      })
      .join("\n");
  },
  parseUsage(jsonl) {
    // Walk the file backwards: the last assistant message carries the most
    // recent (cumulative) usage counts for the iteration.
    const lines = jsonl.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      const usage = extractUsageFromAssistantLine(line);
      if (usage !== undefined) return usage;
    }
    return undefined;
  },
};

function extractUsageFromAssistantLine(line: string): IterationUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed["type"] !== "assistant") return undefined;
  const message = parsed["message"];
  if (!isRecord(message)) return undefined;
  const usage = message["usage"];
  if (!isRecord(usage)) return undefined;
  const inputTokens = numericField(usage, "input_tokens");
  const outputTokens = numericField(usage, "output_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheCreationInputTokens = numericField(
    usage,
    "cache_creation_input_tokens",
  );
  const cacheReadInputTokens = numericField(usage, "cache_read_input_tokens");
  return {
    inputTokens,
    outputTokens,
    ...(cacheCreationInputTokens !== undefined && { cacheCreationInputTokens }),
    ...(cacheReadInputTokens !== undefined && { cacheReadInputTokens }),
  };
}

function numericField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
