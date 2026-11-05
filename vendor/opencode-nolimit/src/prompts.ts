/**
 * Message conversion helpers.
 *
 * The opencode backend accepts a single user message built from text parts.
 * To stay compatible with the stateless OpenAI/Anthropic request shapes, each
 * request renders the full conversation into one well-marked prompt.
 */

export interface IncomingMessage {
  role: string;
  content?: string | Array<{ type?: string; text?: string } | { type?: string; text?: string } | any> | null;
  name?: string;
}

export interface RenderedPrompt {
  system: string;
  text: string;
}

function contentToText(content: IncomingMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

const ROLE_LABEL: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
};

/**
 * Render OpenAI-style messages (any role) into the opencode prompt shape.
 */
export function renderOpenAIMessages(messages: IncomingMessage[]): RenderedPrompt {
  const system: string[] = [];
  const turns: string[] = [];

  for (const msg of messages) {
    const text = contentToText(msg.content);
    if (!text) continue;
    if (msg.role === "system") {
      system.push(text);
      continue;
    }
    const label = msg.role === "tool" ? "Tool result" : ROLE_LABEL[msg.role] ?? msg.role;
    turns.push(`[${label}] ${text}`);
  }

  return {
    system: system.join("\n\n"),
    text: turns.length ? turns.join("\n\n") : "[User] (empty message)",
  };
}

/**
 * Render Anthropic-style messages. `system` may be a string or a list of
 * content blocks; the rest maps to labelled turns like the OpenAI variant.
 */
export function renderAnthropicMessages(body: {
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: IncomingMessage[];
}): RenderedPrompt {
  const system: string[] = [];
  if (typeof body.system === "string") {
    system.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) if (typeof block.text === "string") system.push(block.text);
  }

  const turns: string[] = [];
  for (const msg of body.messages ?? []) {
    const text = contentToText(msg.content);
    if (!text) continue;
    const label = ROLE_LABEL[msg.role] ?? msg.role;
    turns.push(`[${label}] ${text}`);
  }

  return {
    system: system.join("\n\n"),
    text: turns.length ? turns.join("\n\n") : "[User] (empty message)",
  };
}

/** One text part object understood by the opencode backend. */
export function partsFor(prompt: RenderedPrompt): { type: "text"; text: string }[] {
  const block = prompt.system ? `[System]\n${prompt.system}\n\n${prompt.text}` : prompt.text;
  return [{ type: "text", text: block }];
}
