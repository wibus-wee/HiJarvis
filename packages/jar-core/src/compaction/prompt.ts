export const SUMMARY_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. " +
  "You also have access to the state of the tools that were used by that language model. " +
  "Use this to build on the work that has already been done and avoid duplicating work. " +
  "Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const PARTIAL_FROM_SUMMARY_PROMPT = `You are performing a PARTIAL CONTEXT COMPACTION for recent conversation history.

Summarize only the messages provided to you. Earlier context is being preserved separately and should not be redundantly summarized.

Include:
- Current progress and key decisions made in the provided segment
- Important constraints, user requests, and unresolved questions from the provided segment
- What remains to be done next
- Any critical tool outputs, examples, or references needed to continue from this point

Be concise, structured, and focused on helping another LLM continue from the preserved earlier context plus this summary.`;

export const PARTIAL_UP_TO_SUMMARY_PROMPT = `You are performing a PARTIAL CONTEXT COMPACTION for older conversation history.

Summarize only the messages provided to you. Newer raw messages will remain after this summary, so focus on the older context that the next LLM will need in order to understand the preserved newer tail.

Include:
- Original request and intent from the summarized portion
- Important technical decisions and constraints established there
- Work completed before the preserved newer messages begin
- Context the next LLM needs so the preserved newer messages make sense

Be concise, structured, and focused on continuity.`;

export const getSummaryPrompt = (variant: import("./types.js").SummaryPromptVariant): string => {
  switch (variant) {
    case "partial_from":
      return PARTIAL_FROM_SUMMARY_PROMPT;
    case "partial_up_to":
      return PARTIAL_UP_TO_SUMMARY_PROMPT;
    case "full":
    default:
      return SUMMARY_PROMPT;
  }
};
