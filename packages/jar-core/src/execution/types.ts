import type { Agent, AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { Logger } from "../logger.js";
import type { MemoryProviderFactory } from "../memory/index.js";
import type {
  ConversationStateStore,
  EventLogStore,
  ExecutionAuditStore,
  MaterializedConversationState,
  UsageStore,
} from "../persistence.js";
import type { MessageIngressCommand } from "../ingress.js";
import type { SkillsRuntime, SkillPromptInjection } from "../skills.js";
import type { ThreadExecutionTracker } from "../thread-execution.js";
import type { PromptSection } from "../prompt-builder.js";

// ── Result types ──────────────────────────────────────────────

export type MessageIngressResult = {
  kind: "message";
  outputText: string;
  threadId: string;
  turnId: string;
  runId: string;
};

export type SideQuestionIngressResult = {
  kind: "side_question";
  outputText: string;
  parentThreadId: string;
  capturedAt: number;
};

export type IngressResult = MessageIngressResult | SideQuestionIngressResult;

// ── Phase context types ───────────────────────────────────────

/**
 * Phase 1 output: infrastructure stores are ready.
 */
export type StoresContext = {
  config: LoadedRuntimeConfig;
  skills: SkillsRuntime;
  command: MessageIngressCommand;
  logger?: Logger;
  hooks?: HookRegistry;
  stateStore: ConversationStateStore;
  auditStore: ExecutionAuditStore;
  eventStore: EventLogStore;
  usageStore: UsageStore;
  startTime: number;
  pluginOverlays?: PromptSection[];
  pluginTools?: AgentTool[];
  pluginMemoryProvider?: MemoryProviderFactory;
};

/**
 * Phase 2 output: conversation loaded, live thread registered.
 */
export type SessionContext = StoresContext & {
  conversation: MaterializedConversationState;
  requestLogger?: Logger;
};

/**
 * Phase 3 output: prompt prepared with skills, tracker started.
 */
export type PreparedPromptContext = SessionContext & {
  prepared: SkillPromptInjection;
  tracker: ThreadExecutionTracker;
};

/**
 * Phase 4 output: agent created with tools and compaction wiring.
 */
export type AgentContext = PreparedPromptContext & {
  agent: Agent;
  tools: AgentTool[];
  compactionRuntime: {
    model: Agent["state"]["model"];
    systemPrompt: string;
    settings: LoadedRuntimeConfig["agent"]["compaction"];
    apiKey?: string;
    logger?: Logger;
  };
  refreshLiveCapture: () => void;
};

/**
 * Phase 5 output: event subscription active, output collector ready.
 */
export type SubscribedContext = AgentContext & {
  outputRef: { text: string };
};

export type { FaultEnvelope, Fault, FaultKind, FaultPhase, FaultSeverity, FaultSource } from "../fault.js";
