// --- Substrate: runtime agent creation ---
export {
  createAgent,
  supportsModelInput,
  type JarAgentConfig,
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

// --- Substrate: execution facts ---
export {
  generateThreadItemId,
  generateThreadRunId,
  generateThreadTurnId,
  type CompactionEvent,
  type JarEvent,
  type ThreadItem,
  type ThreadItemStatus,
  type ThreadItemType,
  type ThreadRun,
  type ThreadRunKind,
  type ThreadRunStatus,
  type ThreadTurn,
  type ThreadTurnInput,
  type ThreadTurnOutput,
  type ThreadTurnStatus,
  type ThreadTurnTrigger,
  type UsageRecord,
} from "./execution-types.js";

// --- Substrate: lanes ---
export {
  appendTapeRecord,
  ensureThreadMeta,
  listThreads,
  materializeLaneView,
  openTape,
  openConversationHandle,
  readTapeRecords,
  touchThread,
  type ConversationHandle,
  type LaneCheckpointPayload,
  type LaneMeta,
  type MaterializedLaneView,
  type TapeHandle,
  type TapeRecord,
  type ThreadListItem,
  type ThreadMeta,
} from "./lanes/index.js";

// --- Runtime-only side-question substrate ---
export {
  captureLiveThreadForSideQuestion,
  executeSideQuestion,
  normalizeSideQuestionPromptToMessages,
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
  type SideQuestionResult,
  type SideQuestionLiveThreadCapture,
} from "./side-question/index.js";

// --- Substrate: session execution tracking ---
export {
  countPromptMessages,
  estimatePromptChars,
  startThreadExecutionTracker,
  type ThreadExecutionTracker,
  type ThreadExecutionTrackerOptions,
} from "./thread-execution.js";

// --- Substrate: logging ---
export {
  createLogger,
  logLevels,
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerOptions,
} from "./logger.js";

// --- Substrate: memory ---
export {
  FileSystemMemoryProvider,
  createMemoryDeleteTool,
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryTools,
  createMemoryUpdateTool,
  resolveConfiguredMemoryProvider,
} from "./memory/index.js";
export type {
  CreateMemoryProviderContext,
  MemoryEntry,
  MemoryProvider,
  MemoryProviderFactory,
  MemorySearchResult,
} from "./memory/index.js";

// --- Substrate: tool contract ---
export type { ToolOptions } from "./tools.js";

// --- Convenience: config loading ---
export {
  loadAgentConfig,
  loadBaseConfig,
  loadRuntimeConfig,
  resolveSkillsFromConfig,
  type LoadedEntityConfig,
  type LoadedAgentConfig,
  type LoadedBaseConfig,
  type LoadedMemoryConfig,
  type PlatformIdentityRef,
  type LoadedRuntimeConfig,
} from "./config.js";

// --- Ingress and execution services ---
export {
  buildDefaultSkillTriggerText,
  buildThreadIdFromScope,
  buildTurnInputMetadata,
  parseSideQuestionCommand,
  type IngressCommand,
  type IngressObservedMessage,
  type IngressScope,
  type IngressSource,
  type LocalThreadScope,
  type MessageIngressCommand,
  type ParsedSideQuestionCommand,
  type RoutedScope,
  type SideQuestionIngressCommand,
  type SlackScope,
  type TelegramScope,
} from "./ingress.js";
export {
  executeIngressCommand,
  IngressExecutionError,
  maybeExecuteSideQuestionIngress,
  resolveEntityMemoryScope,
  resolveMessageTools,
  type IngressResult,
  type MessageIngressResult,
  type SideQuestionIngressResult,
} from "./execution-service.js";
export type {
  AppendConversationMessageInput,
  ApplyCheckpointInput,
  ConversationStateStore,
  EventLogStore,
  ExecutionAuditStore,
  MaterializedConversationState,
  UsageStore,
} from "./persistence.js";
export { createFileSystemUsageStore } from "./persistence.js";

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

// --- Substrate: hooks ---
export { createHookRegistry } from "./hooks/index.js";
export type {
  HookHandler,
  HookMap,
  HookPoint,
  HookRegistration,
  HookRegistry,
  HookRegistryOptions,
  TapHookPoint,
  TransformHookPoint,
} from "./hooks/index.js";

// --- Re-exported upstream types ---
export type { AgentMessage } from "@mariozechner/pi-agent-core";
export type { ImageContent, UserMessage } from "@mariozechner/pi-ai";
