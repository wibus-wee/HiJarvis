import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { PromptInput } from "./prompt-executor.js";

export type PromptContextPersistence = "memory_excluded";

export type PromptContextFragment = {
  kind: "skill";
  persistence: PromptContextPersistence;
  name: string;
  path: string;
  body: string;
};

const MEMORY_EXCLUDED_BLOCK_PATTERNS = [
  /<skill>[\s\S]*?<\/skill>/g,
];

export const injectPromptContextFragments = (
  prompt: PromptInput,
  fragments: PromptContextFragment[],
): PromptInput => {
  if (fragments.length === 0) {
    return prompt;
  }

  const rendered = fragments.map(renderPromptContextFragment).join("\n\n");

  if (typeof prompt === "string") {
    return `${rendered}\n\n${prompt}`.trim();
  }

  if (Array.isArray(prompt)) {
    return injectIntoMessages(prompt, rendered);
  }

  return injectIntoMessages([prompt], rendered);
};

export const stripMemoryExcludedPromptContext = (text: string): string => {
  if (!text.includes("<")) {
    return text;
  }

  const stripped = MEMORY_EXCLUDED_BLOCK_PATTERNS.reduce((current, pattern) => {
    return current.replace(pattern, "");
  }, text);

  return stripped.replace(/\n{3,}/g, "\n\n").trim();
};

export const stripMemoryExcludedPromptContextFromMessage = (
  message: AgentMessage,
): AgentMessage => {
  if (!("role" in message) || message.role !== "user") {
    return message;
  }

  if (typeof message.content === "string") {
    return {
      ...message,
      content: stripMemoryExcludedPromptContext(message.content),
    };
  }

  return {
    ...message,
    content: message.content.map((item) => {
      if (item.type !== "text") {
        return item;
      }

      return {
        ...item,
        text: stripMemoryExcludedPromptContext(item.text),
      };
    }),
  };
};

export const stripMemoryExcludedPromptContextFromHistory = (
  messages: AgentMessage[],
): AgentMessage[] => {
  let preservedLatestUser = false;
  const result = messages.slice();

  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index];
    if (!message || !("role" in message) || message.role !== "user") {
      continue;
    }

    if (!preservedLatestUser) {
      preservedLatestUser = true;
      continue;
    }

    result[index] = stripMemoryExcludedPromptContextFromMessage(message);
  }

  return result;
};

export const getPromptTextInput = (prompt: PromptInput): string => {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    return prompt
      .map(messageToTextInput)
      .filter((value) => value.length > 0)
      .join("\n");
  }

  return messageToTextInput(prompt);
};

const renderPromptContextFragment = (
  fragment: PromptContextFragment,
): string => {
  switch (fragment.kind) {
    case "skill":
      return [
        "<skill>",
        `<name>${fragment.name}</name>`,
        `<path>${normalizePath(fragment.path)}</path>`,
        fragment.body,
        "</skill>",
      ].join("\n");
  }
};

const injectIntoMessages = (
  messages: AgentMessage[],
  renderedFragments: string,
): AgentMessage[] => {
  if (messages.length === 0) {
    return [{
      role: "user",
      content: renderedFragments,
      timestamp: Date.now(),
    }];
  }

  const nextMessages = messages.slice();
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (!message || !("role" in message) || message.role !== "user") {
      continue;
    }

    nextMessages[index] = prependToUserMessage(message, renderedFragments);
    return nextMessages;
  }

  nextMessages.unshift({
    role: "user",
    content: renderedFragments,
    timestamp: Date.now(),
  });
  return nextMessages;
};

const prependToUserMessage = (
  message: Extract<AgentMessage, { role: "user" }>,
  renderedFragments: string,
): Extract<AgentMessage, { role: "user" }> => {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: `${renderedFragments}\n\n${message.content}`.trim(),
    };
  }

  let injected = false;
  const nextContent = message.content.map((item) => {
    if (item.type !== "text" || injected) {
      return item;
    }

    injected = true;
    return {
      ...item,
      text: `${renderedFragments}\n\n${item.text}`.trim(),
    };
  });

  if (injected) {
    return {
      ...message,
      content: nextContent,
    };
  }

  return {
    ...message,
    content: [{
      type: "text",
      text: renderedFragments,
    }, ...message.content],
  };
};

const messageToTextInput = (message: AgentMessage): string => {
  if (!("role" in message) || message.role !== "user") {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

const normalizePath = (value: string): string => {
  return value.replace(/\\/g, "/");
};
