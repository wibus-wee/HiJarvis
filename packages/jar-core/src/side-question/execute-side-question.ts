import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  executePromptWithPolicy,
  type PromptInput,
} from "../prompt-executor.js";
import { createAgent } from "../runtime.js";
import { preparePromptWithSkills } from "../skills.js";
import { captureLiveThreadForSideQuestion } from "./live-thread-registry.js";

export type SideQuestionResult = {
  outputText: string;
  parentThreadId: string;
  capturedAt: number;
};

export const executeSideQuestion = async (options: {
  config: LoadedRuntimeConfig;
  parentThreadId: string;
  question: PromptInput;
  skillTriggerText?: string;
  tools?: AgentTool[];
  logger?: Logger;
}): Promise<SideQuestionResult> => {
  const capture = captureLiveThreadForSideQuestion(options.parentThreadId);
  if (capture === null) {
    throw new Error(`No live parent thread available for ${options.parentThreadId}`);
  }

  const preparedQuestion = await preparePromptWithSkills(options.question, {
    skills: options.config.skills,
    triggerText: options.skillTriggerText,
    logger: options.logger,
  });

  const agentConfig = options.config.agent;
  const agent = createAgent({
    ...agentConfig,
    tools: options.tools ?? ([] satisfies AgentTool[]),
    logger: options.logger,
    compactionEventSink: () => {
      // side questions are runtime-only and never persist compaction records
    },
  });

  agent.sessionId = `side-question:${capture.threadId}:${capture.capturedAt}`;
  agent.state.messages = [
    ...capture.messages.map(cloneAgentMessage),
    ...normalizeSideQuestionPromptToMessages(preparedQuestion.prompt),
  ];

  let outputText = "";
  agent.subscribe(async (event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      outputText += event.assistantMessageEvent.delta;
    }
  });

  await executePromptWithPolicy(
    agent,
    preparedQuestion.prompt,
    agentConfig.execution,
    { stderr: process.stderr },
    options.logger,
    {},
  );

  return {
    outputText,
    parentThreadId: capture.threadId,
    capturedAt: capture.capturedAt,
  };
};

export const normalizeSideQuestionPromptToMessages = (
  prompt: PromptInput,
): AgentMessage[] => {
  if (typeof prompt === "string") {
    return [{ role: "user", content: prompt, timestamp: Date.now() }];
  }

  return Array.isArray(prompt)
    ? prompt.map(cloneAgentMessage)
    : [cloneAgentMessage(prompt)];
};

const cloneAgentMessage = <T extends AgentMessage>(message: T): T => {
  return structuredClone(message);
};
