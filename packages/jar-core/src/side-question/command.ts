import type { LoadedRuntimeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { executeSideQuestion } from "./execute-side-question.js";

const btwPattern = /^\/btw\b/i;

export type ParsedSideQuestionCommand = {
  question: string;
};

export const parseSideQuestionCommand = (
  input: string,
): ParsedSideQuestionCommand | null => {
  if (!btwPattern.test(input)) {
    return null;
  }

  const question = input.replace(btwPattern, "").trim();
  if (question.length === 0) {
    return null;
  }

  return { question };
};

export const maybeExecuteSideQuestionCommand = async (options: {
  config: LoadedRuntimeConfig;
  parentThreadId: string;
  input: string;
  logger?: Logger;
}): Promise<{ handled: false } | { handled: true; outputText: string }> => {
  const parsed = parseSideQuestionCommand(options.input);
  if (parsed === null) {
    return { handled: false };
  }

  const result = await executeSideQuestion({
    config: options.config,
    parentThreadId: options.parentThreadId,
    question: parsed.question,
    skillTriggerText: parsed.question,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  return {
    handled: true,
    outputText: result.outputText,
  };
};
