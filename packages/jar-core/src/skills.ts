import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Logger } from "./logger.js";
import type { PromptSection } from "./prompt-builder.js";
import {
  getPromptTextInput,
  injectPromptContextFragments,
  stripMemoryExcludedPromptContext,
  stripMemoryExcludedPromptContextFromHistory,
  stripMemoryExcludedPromptContextFromMessage,
  type PromptContextFragment,
} from "./prompt-context.js";
import type { PromptInput } from "./prompt-executor.js";

export type SkillEntry = {
  name: string;
  description: string;
  path: string;
  allowImplicitInvocation: boolean;
};

export type SkillLoadError = {
  path: string;
  message: string;
};

export type SkillsRuntime = {
  enabled: boolean;
  roots: string[];
  maxScanDepth: number;
  maxSkills: number;
  maxCatalogChars: number;
  maxBodyChars: number;
  entries: SkillEntry[];
  catalog: string | null;
  errors: SkillLoadError[];
  truncatedByLimit: boolean;
};

export type SkillsConfigInput = {
  enabled?: boolean;
  roots?: string[];
  maxScanDepth?: number;
  maxSkills?: number;
  maxCatalogChars?: number;
  maxBodyChars?: number;
};

const DEFAULT_MAX_SCAN_DEPTH = 6;
const DEFAULT_MAX_SKILLS = 2000;
const DEFAULT_MAX_CATALOG_CHARS = 12_000;
const DEFAULT_MAX_BODY_CHARS = 20_000;
const SKILL_FILENAME = "SKILL.md";

const SKILLS_USAGE_BLOCK = [
  "### How to use skills",
  "- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.",
  "- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.",
  "- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.",
  "- How to use a skill (progressive disclosure):",
  "  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.",
  "  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the skill directory listed above first, and only consider other paths if needed.",
  "  3) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.",
  "  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.",
  "  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.",
  "- Coordination and sequencing:",
  "  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.",
  "  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.",
  "- Context hygiene:",
  "  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.",
  "  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.",
  "  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.",
  "- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.",
];

export const getSkillsCatalogOverlays = (
  skills: SkillsRuntime | undefined,
): PromptSection[] => {
  return skills?.catalog ? [{ body: skills.catalog }] : [];
};

export const resolveSkillsRuntime = async (
  input: SkillsConfigInput | undefined,
  configDirectory: string,
): Promise<SkillsRuntime> => {
  const enabled = input?.enabled ?? true;
  const maxScanDepth = input?.maxScanDepth ?? DEFAULT_MAX_SCAN_DEPTH;
  const maxSkills = input?.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxCatalogChars = input?.maxCatalogChars ?? DEFAULT_MAX_CATALOG_CHARS;
  const maxBodyChars = input?.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const roots = resolveSkillRoots(input?.roots, configDirectory);

  if (!enabled) {
    return {
      enabled: false,
      roots,
      maxScanDepth,
      maxSkills,
      maxCatalogChars,
      maxBodyChars,
      entries: [],
      catalog: null,
      errors: [],
      truncatedByLimit: false,
    };
  }

  const loadResult = await loadSkillsFromRoots({
    roots,
    maxScanDepth,
    maxSkills,
  });
  const entries = loadResult.entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const catalog = renderSkillsCatalog(entries, maxCatalogChars);

  return {
    enabled: true,
    roots,
    maxScanDepth,
    maxSkills,
    maxCatalogChars,
    maxBodyChars,
    entries,
    catalog,
    errors: loadResult.errors,
    truncatedByLimit: loadResult.truncatedByLimit,
  };
};

export type SkillPromptInjection = {
  prompt: PromptInput;
  injectedSkills: string[];
  warnings: string[];
};

export type SkillPromptContext = {
  fragments: PromptContextFragment[];
  injectedSkills: string[];
  warnings: string[];
};

export const resolveSkillPromptContext = async (
  options: {
    skills?: SkillsRuntime;
    triggerText?: string;
    prompt?: PromptInput;
    logger?: Logger;
  },
): Promise<SkillPromptContext> => {
  const skills = options.skills;
  if (!skills || !skills.enabled || skills.entries.length === 0) {
    return {
      fragments: [],
      injectedSkills: [],
      warnings: [],
    };
  }

  const triggerText = options.triggerText ?? (
    options.prompt === undefined ? "" : getPromptTextInput(options.prompt)
  );
  if (triggerText.trim().length === 0) {
    return {
      fragments: [],
      injectedSkills: [],
      warnings: [],
    };
  }

  const mentions = collectSkillMentions(triggerText, skills.entries);
  if (mentions.length === 0) {
    return {
      fragments: [],
      injectedSkills: [],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const fragments: PromptContextFragment[] = [];
  for (const skill of mentions) {
    try {
      const rawContents = await readFile(skill.path, "utf8");
      const normalized = rawContents.trim();
      const truncated = truncateIfNeeded(normalized, skills.maxBodyChars);
      fragments.push({
        kind: "skill",
        persistence: "memory_excluded",
        name: skill.name,
        path: skill.path,
        body: [truncated.text, truncated.note].filter((line) => line.length > 0).join("\n"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Failed to load skill ${skill.name} at ${skill.path}: ${message}`;
      warnings.push(warning);
      options.logger?.warn("skills.injection_failed", {
        skillName: skill.name,
        skillPath: skill.path,
        message,
      });
    }
  }

  return {
    fragments,
    injectedSkills: mentions.map((skill) => skill.name),
    warnings,
  };
};

export const preparePromptWithSkills = async (
  prompt: PromptInput,
  options: {
    skills?: SkillsRuntime;
    triggerText?: string;
    logger?: Logger;
  },
): Promise<SkillPromptInjection> => {
  const context = await resolveSkillPromptContext({
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.triggerText === undefined ? {} : { triggerText: options.triggerText }),
    prompt,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  if (context.fragments.length === 0) {
    return {
      prompt,
      injectedSkills: context.injectedSkills,
      warnings: context.warnings,
    };
  }

  return {
    prompt: injectPromptContextFragments(prompt, context.fragments),
    injectedSkills: context.injectedSkills,
    warnings: context.warnings,
  };
};

export const stripSkillBlocks = (text: string): string => {
  return stripMemoryExcludedPromptContext(text);
};

export const stripSkillBlocksFromMessage = stripMemoryExcludedPromptContextFromMessage;

export const stripSkillBlocksFromHistory = stripMemoryExcludedPromptContextFromHistory;

const resolveSkillRoots = (
  roots: string[] | undefined,
  configDirectory: string,
): string[] => {
  if (roots && roots.length > 0) {
    return roots.map((root) => resolveRootPath(root, configDirectory));
  }

  const homeDir = os.homedir();
  return [
    path.resolve(configDirectory, ".jarvis/skills"),
    path.resolve(homeDir, ".jarvis/skills"),
  ];
};

const resolveRootPath = (root: string, configDirectory: string): string => {
  if (root.startsWith("~/") || root === "~") {
    return path.resolve(os.homedir(), root.slice(2));
  }
  if (path.isAbsolute(root)) {
    return root;
  }
  return path.resolve(configDirectory, root);
};

const loadSkillsFromRoots = async (options: {
  roots: string[];
  maxScanDepth: number;
  maxSkills: number;
}): Promise<{ entries: SkillEntry[]; errors: SkillLoadError[]; truncatedByLimit: boolean }> => {
  const entries: SkillEntry[] = [];
  const errors: SkillLoadError[] = [];
  const seen = new Set<string>();
  let truncatedByLimit = false;

  for (const root of options.roots) {
    if (entries.length >= options.maxSkills) {
      truncatedByLimit = true;
      break;
    }

    const resolvedRoot = path.resolve(root);
    if (!(await isDirectory(resolvedRoot))) {
      continue;
    }

    const queue: Array<{ dir: string; depth: number }> = [
      { dir: resolvedRoot, depth: 0 },
    ];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }

      const { dir, depth } = next;
      if (depth > options.maxScanDepth) {
        continue;
      }

      try {
        const dirEntries = await readdir(dir, {
          withFileTypes: true,
          encoding: "utf8",
        });

        for (const entry of dirEntries) {
          if (entries.length >= options.maxSkills) {
            truncatedByLimit = true;
            break;
          }

          if (entry.name.startsWith(".")) {
            continue;
          }

          const entryPath = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            continue;
          }

          if (entry.isDirectory()) {
            queue.push({ dir: entryPath, depth: depth + 1 });
            continue;
          }

          if (entry.isFile() && entry.name === SKILL_FILENAME) {
            const resolvedPath = path.resolve(entryPath);
            if (seen.has(resolvedPath)) {
              continue;
            }
            seen.add(resolvedPath);
            const parsed = await parseSkillFile(resolvedPath);
            if (parsed.entry) {
              entries.push(parsed.entry);
            }
            if (parsed.error) {
              errors.push(parsed.error);
            }
          }
        }
      } catch (error) {
        errors.push({
          path: dir,
          message: `Failed to read directory: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
  }

  return {
    entries,
    errors,
    truncatedByLimit,
  };
};

const parseSkillFile = async (skillPath: string): Promise<{ entry?: SkillEntry; error?: SkillLoadError }> => {
  let contents: string;
  try {
    contents = await readFile(skillPath, "utf8");
  } catch (error) {
    return {
      error: {
        path: skillPath,
        message: `Failed to read skill file: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const frontmatter = extractFrontmatter(contents);
  if (!frontmatter) {
    return {
      error: {
        path: skillPath,
        message: "Missing YAML frontmatter delimited by ---",
      },
    };
  }

  const parsed = parseYamlFrontmatter(frontmatter);
  const description = sanitizeSingleLine(parsed.description ?? "");
  if (description.length === 0) {
    return {
      error: {
        path: skillPath,
        message: "Missing required field: description",
      },
    };
  }

  const fallbackName = sanitizeSingleLine(path.basename(path.dirname(skillPath)));
  const name = sanitizeSingleLine(parsed.name ?? fallbackName);
  if (name.length === 0) {
    return {
      error: {
        path: skillPath,
        message: "Missing required field: name",
      },
    };
  }

  const allowImplicitInvocation = await parseAllowImplicitInvocation(skillPath);

  return {
    entry: {
      name,
      description,
      path: skillPath,
      allowImplicitInvocation,
    },
  };
};

const parseAllowImplicitInvocation = async (skillPath: string): Promise<boolean> => {
  const openaiYamlPath = path.join(path.dirname(skillPath), "agents", "openai.yaml");
  try {
    const contents = await readFile(openaiYamlPath, "utf8");
    const match = contents.match(/^[\t ]*allow_implicit_invocation\s*:\s*(true|false)\s*$/im);
    if (!match) {
      return true;
    }
    return match[1]?.toLowerCase() === "true";
  } catch {
    return true;
  }
};

const extractFrontmatter = (contents: string): string | null => {
  const lines = contents.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    return null;
  }

  const frontmatterLines: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.trim() === "---") {
      return frontmatterLines.join("\n");
    }
    if (line !== undefined) {
      frontmatterLines.push(line);
    }
  }

  return null;
};

const parseYamlFrontmatter = (frontmatter: string): { name?: string; description?: string } => {
  const result: { name?: string; description?: string } = {};
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = stripYamlQuotes(rawValue);
    if (key === "name") {
      result.name = value;
    }
    if (key === "description") {
      result.description = value;
    }
  }
  return result;
};

const stripYamlQuotes = (value: string): string => {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
};

const sanitizeSingleLine = (value: string): string => {
  return value.split(/\s+/).filter(Boolean).join(" ").trim();
};

const renderSkillsCatalog = (
  entries: SkillEntry[],
  maxCatalogChars: number,
): string | null => {
  const availableSkills = entries.filter((skill) => skill.allowImplicitInvocation);
  if (availableSkills.length === 0) {
    return null;
  }

  const headerLines = [
    "## Skills",
    "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.",
    "### Available skills",
  ];

  const skillLines = availableSkills.map((skill) => {
    return `- ${skill.name}: ${skill.description} (file: ${normalizePath(skill.path)})`;
  });

  const usageLines = SKILLS_USAGE_BLOCK;
  const catalogLines = trimCatalogLines({
    headerLines,
    skillLines,
    usageLines,
    maxChars: maxCatalogChars,
  });

  return catalogLines.join("\n");
};

const trimCatalogLines = (input: {
  headerLines: string[];
  skillLines: string[];
  usageLines: string[];
  maxChars: number;
}): string[] => {
  const { headerLines, skillLines, usageLines, maxChars } = input;
  const lines = [...headerLines, ...skillLines, ...usageLines];
  if (estimateJoinedLength(lines) <= maxChars) {
    return lines;
  }

  let trimmedSkills = skillLines.slice();
  while (trimmedSkills.length > 0) {
    const candidate = [...headerLines, ...trimmedSkills, ...usageLines];
    if (estimateJoinedLength(candidate) <= maxChars) {
      return candidate;
    }
    trimmedSkills.pop();
  }

  const fallback = [...headerLines, ...usageLines];
  return estimateJoinedLength(fallback) <= maxChars ? fallback : headerLines;
};

const estimateJoinedLength = (lines: string[]): number => {
  if (lines.length === 0) {
    return 0;
  }
  return lines.reduce((total, line) => total + line.length, 0) + (lines.length - 1);
};

const collectSkillMentions = (text: string, skills: SkillEntry[]): SkillEntry[] => {
  const nameCounts = new Map<string, number>();
  for (const skill of skills) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }

  const skillByName = new Map<string, SkillEntry>();
  for (const skill of skills) {
    if ((nameCounts.get(skill.name) ?? 0) > 1) {
      continue;
    }
    skillByName.set(skill.name, skill);
  }

  const mentions = extractMentionNames(text);
  const selected: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const name of mentions) {
    const skill = skillByName.get(name);
    if (!skill || seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    selected.push(skill);
  }

  return selected;
};

const extractMentionNames = (text: string): string[] => {
  const names: string[] = [];
  const pattern = /(^|[^A-Za-z0-9_.:-])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[2];
    if (name) {
      names.push(name);
    }
  }
  return names;
};

const truncateIfNeeded = (
  text: string,
  maxChars: number,
): { text: string; note: string } => {
  if (text.length <= maxChars) {
    return { text, note: "" };
  }
  const truncated = text.slice(0, Math.max(0, maxChars - 3));
  return {
    text: `${truncated}...`,
    note: `[skill content truncated to ${maxChars} chars]`,
  };
};

const normalizePath = (value: string): string => {
  return value.replace(/\\/g, "/");
};

const isDirectory = async (value: string): Promise<boolean> => {
  try {
    const stats = await stat(value);
    return stats.isDirectory();
  } catch {
    return false;
  }
};
