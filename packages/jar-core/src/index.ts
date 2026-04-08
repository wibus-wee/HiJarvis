// --- Substrate: runtime agent creation ---
export {
  createAgent,
  supportsModelInput,
  type JarRuntimeOptions,
  type RuntimeProviderConfig,
} from "./runtime.js";

// --- Substrate: prompt composition ---
export {
  buildSystemPrompt,
  buildTurnPrompt,
  type PromptSection,
  type SystemPromptInput,
  type TurnPromptInput,
} from "./prompt-builder.js";
export {
  getPromptTextInput,
  injectPromptContextFragments,
  stripMemoryExcludedPromptContext,
  stripMemoryExcludedPromptContextFromHistory,
  stripMemoryExcludedPromptContextFromMessage,
  type PromptContextFragment,
  type PromptContextPersistence,
} from "./prompt-context.js";

// --- Substrate: prompt execution ---
export {
  classifyPromptFailure,
  executePromptWithPolicy,
  getRetryDelayMs,
  type PromptExecutionObserver,
  type PromptAgent,
  type PromptErrorCategory,
  type PromptExecutionPolicy,
} from "./prompt-executor.js";

// --- Substrate: session store ---
export {
  generateSessionItemId,
  generateSessionRunId,
  generateSessionTurnId,
  listSessions,
  openSession,
  type SessionHandle,
  type SessionItem,
  type SessionItemRecord,
  type SessionItemStatus,
  type SessionItemType,
  type SessionRun,
  type SessionRunKind,
  type SessionRunRecord,
  type SessionRunStatus,
  type SessionTurn,
  type SessionTurnInput,
  type SessionTurnOutput,
  type SessionTurnRecord,
  type SessionTurnStatus,
  type SessionTurnTrigger,
} from "./session-store.js";

// --- Substrate: session execution tracking ---
export {
  countPromptMessages,
  estimatePromptChars,
  startSessionExecutionTracker,
  type SessionExecutionTracker,
  type SessionExecutionTrackerOptions,
} from "./session-execution.js";

// --- Substrate: logging ---
export {
  createLogger,
  logLevels,
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerOptions,
} from "./logger.js";

// --- Substrate: tool contract ---
export type { ToolOptions } from "./tools.js";

// --- Convenience: config loading ---
export {
  loadAgentConfig,
  loadBaseConfig,
  loadRuntimeConfig,
  resolveSkillsFromConfig,
  type LoadedAgentConfig,
  type LoadedBaseConfig,
  type LoadedRuntimeConfig,
} from "./config.js";

// --- Convenience: session execution ---
export {
  executePromptInSession,
  SessionExecutionError,
  type SessionPromptOptions,
  type SessionPromptResult,
} from "./session-executor.js";

// --- Convenience: skills ---
export {
  getSkillsCatalogOverlays,
  preparePromptWithSkills,
  resolveSkillsRuntime,
  resolveSkillPromptContext,
  stripSkillBlocks,
  stripSkillBlocksFromHistory,
  stripSkillBlocksFromMessage,
  type SkillEntry,
  type SkillLoadError,
  type SkillPromptContext,
  type SkillPromptInjection,
  type SkillsConfigInput,
  type SkillsRuntime,
} from "./skills.js";

// --- Convenience: default tools ---
export { createDefaultTools } from "./tools.js";

// --- Re-exported upstream types ---
export type { AgentMessage } from "@mariozechner/pi-agent-core";
export type { ImageContent, UserMessage } from "@mariozechner/pi-ai";
