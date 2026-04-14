// Phase pipeline for executeMessageCommand
export { initStores } from "./phase-init-stores.js";
export { loadSession } from "./phase-load-session.js";
export { preparePrompt } from "./phase-prepare-prompt.js";
export { createAgentContext } from "./phase-create-agent.js";
export { subscribeEvents } from "./phase-subscribe.js";
export { executeAndFinalize } from "./phase-execute.js";

// Extracted utilities (no circular dependency)
export { resolveEntityMemoryScope, resolveMessageTools } from "./resolve-tools.js";

// Shared types
export type {
  StoresContext,
  SessionContext,
  PreparedPromptContext,
  AgentContext,
  SubscribedContext,
  MessageIngressResult,
  SideQuestionIngressResult,
  IngressResult,
} from "./types.js";
export type { FaultEnvelope, Fault, FaultKind, FaultPhase, FaultSeverity, FaultSource } from "./types.js";
