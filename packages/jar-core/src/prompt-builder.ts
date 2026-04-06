export type PromptSection = {
  title?: string;
  body: string;
};

export type TurnPromptInput = {
  lead?: string[];
  sections?: PromptSection[];
};

export type SystemPromptInput = {
  basePrompt: string;
  sections?: PromptSection[];
};

export const buildSystemPrompt = (input: SystemPromptInput): string => {
  return buildTurnPrompt({
    sections: [{ body: input.basePrompt }, ...(input.sections ?? [])],
  });
};

export const buildTurnPrompt = (input: TurnPromptInput): string => {
  const segments = [
    ...(input.lead ?? []).map(normalizeSegment),
    ...(input.sections ?? []).map(formatSection),
  ].filter((segment) => segment.length > 0);

  return segments.join("\n\n");
};

const formatSection = (section: PromptSection): string => {
  const body = normalizeSegment(section.body);
  if (body.length === 0) {
    return "";
  }

  const title = normalizeSegment(section.title ?? "");
  return title.length === 0 ? body : `${title}:\n${body}`;
};

const normalizeSegment = (value: string): string => {
  return value.trim();
};
