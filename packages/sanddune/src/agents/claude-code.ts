import type { AgentProvider, AgentStreamEvent } from "../core";

export interface ClaudeCodeOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export function claudeCode(
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider {
  return {
    name: "claude-code",
    env: options?.env,
    buildCommand: ({ prompt }) => {
      const args = [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        shellQuote(model),
        "--dangerously-skip-permissions",
        shellQuote(prompt),
      ];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
