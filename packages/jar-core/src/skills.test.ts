import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  preparePromptWithSkills,
  resolveSkillPromptContext,
  resolveSkillsRuntime,
  stripSkillBlocks,
  stripSkillBlocksFromHistory,
  stripSkillBlocksFromMessage,
  type SkillsRuntime,
} from "./skills.js";

const makeAssistantMessage = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{
    type: "text",
    text,
  }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop",
  timestamp: 2,
});

const writeSkill = async (options: {
  rootDir: string;
  dirName: string;
  frontmatter?: string[];
  body?: string[];
  openaiYaml?: string;
}): Promise<string> => {
  const skillDir = path.join(options.rootDir, options.dirName);
  await mkdir(skillDir, { recursive: true });

  const frontmatter = options.frontmatter ?? [
    `name: ${options.dirName}`,
    `description: ${options.dirName} description`,
  ];
  const body = options.body ?? ["# Skill", "", `Use ${options.dirName}.`];

  const skillPath = path.join(skillDir, "SKILL.md");
  await writeFile(
    skillPath,
    [
      "---",
      ...frontmatter,
      "---",
      ...body,
      "",
    ].join("\n"),
    "utf8",
  );

  if (options.openaiYaml !== undefined) {
    const agentsDir = path.join(skillDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, "openai.yaml"), options.openaiYaml, "utf8");
  }

  return skillPath;
};

const createSkillsRuntime = async (rootDir: string): Promise<SkillsRuntime> => {
  return resolveSkillsRuntime(
    {
      roots: [rootDir],
    },
    rootDir,
  );
};

test("resolveSkillsRuntime loads skills and filters implicit catalog entries", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-skills-"));
  try {
    const alphaPath = await writeSkill({
      rootDir,
      dirName: "alpha",
      frontmatter: [
        "name: alpha",
        "description: Explicit alpha skill",
      ],
    });
    await writeSkill({
      rootDir,
      dirName: "beta",
      frontmatter: [
        "description: Uses folder name as fallback",
      ],
    });
    await writeSkill({
      rootDir,
      dirName: "hidden",
      frontmatter: [
        "name: hidden",
        "description: Hidden from catalog",
      ],
      openaiYaml: "allow_implicit_invocation: false\n",
    });

    const runtime = await createSkillsRuntime(rootDir);

    assert.equal(runtime.enabled, true);
    assert.deepEqual(
      runtime.entries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        allowImplicitInvocation: entry.allowImplicitInvocation,
        path: entry.path,
      })),
      [
        {
          name: "alpha",
          description: "Explicit alpha skill",
          allowImplicitInvocation: true,
          path: alphaPath,
        },
        {
          name: "beta",
          description: "Uses folder name as fallback",
          allowImplicitInvocation: true,
          path: path.join(rootDir, "beta", "SKILL.md"),
        },
        {
          name: "hidden",
          description: "Hidden from catalog",
          allowImplicitInvocation: false,
          path: path.join(rootDir, "hidden", "SKILL.md"),
        },
      ],
    );
    assert.match(runtime.catalog ?? "", /- alpha:/);
    assert.match(runtime.catalog ?? "", /- beta:/);
    assert.doesNotMatch(runtime.catalog ?? "", /- hidden:/);
    assert.deepEqual(runtime.errors, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("preparePromptWithSkills injects mentioned skills into string prompts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-skills-"));
  try {
    await writeSkill({
      rootDir,
      dirName: "alpha",
      frontmatter: [
        "name: alpha",
        "description: Explicit alpha skill",
      ],
      body: [
        "# Alpha",
        "",
        "Use alpha workflow.",
      ],
    });

    const runtime = await createSkillsRuntime(rootDir);
    const prepared = await preparePromptWithSkills(
      "Please use $alpha for this request.",
      {
        skills: runtime,
      },
    );

    assert.deepEqual(prepared.injectedSkills, ["alpha"]);
    assert.equal(prepared.warnings.length, 0);
    assert.match(prepared.prompt as string, /<skill>/);
    assert.match(prepared.prompt as string, /<name>alpha<\/name>/);
    assert.match(prepared.prompt as string, /Use alpha workflow\./);
    assert.match(prepared.prompt as string, /Please use \$alpha for this request\./);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("resolveSkillPromptContext returns memory-excluded skill fragments", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-skills-"));
  try {
    const skillPath = await writeSkill({
      rootDir,
      dirName: "alpha",
      frontmatter: [
        "name: alpha",
        "description: Explicit alpha skill",
      ],
      body: [
        "# Alpha",
        "",
        "Use alpha workflow.",
      ],
    });

    const runtime = await createSkillsRuntime(rootDir);
    const context = await resolveSkillPromptContext({
      skills: runtime,
      triggerText: "Please use $alpha now.",
    });

    assert.deepEqual(context.injectedSkills, ["alpha"]);
    assert.equal(context.warnings.length, 0);
    assert.deepEqual(context.fragments, [{
      kind: "skill",
      persistence: "memory_excluded",
      name: "alpha",
      path: skillPath,
      body: "---\nname: alpha\ndescription: Explicit alpha skill\n---\n# Alpha\n\nUse alpha workflow.",
    }]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("preparePromptWithSkills prepends a text block when the latest user message has no text content", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-skills-"));
  try {
    await writeSkill({
      rootDir,
      dirName: "vision",
      frontmatter: [
        "name: vision",
        "description: Vision skill",
      ],
    });

    const runtime = await createSkillsRuntime(rootDir);
    const prepared = await preparePromptWithSkills(
      [{
        role: "user",
        content: [{
          type: "image",
          data: "ZmFrZQ==",
          mimeType: "image/png",
        }],
        timestamp: Date.now(),
      } as AgentMessage],
      {
        skills: runtime,
        triggerText: "Use $vision on this image.",
      },
    );

    assert.deepEqual(prepared.injectedSkills, ["vision"]);
    assert.ok(Array.isArray(prepared.prompt));
    const message = prepared.prompt[0] as Extract<AgentMessage, { role: "user" }>;
    assert.ok(Array.isArray(message.content));
    assert.equal(message.content[0]?.type, "text");
    if (message.content[0]?.type === "text") {
      assert.match(message.content[0].text, /<name>vision<\/name>/);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("stripSkillBlocks helpers remove persisted skill payloads while preserving the latest turn boundary", () => {
  const skillBlock = [
    "<skill>",
    "<name>alpha</name>",
    "Alpha body",
    "</skill>",
  ].join("\n");
  const history: AgentMessage[] = [
    {
      role: "user",
      content: `${skillBlock}\n\nOlder request`,
      timestamp: 1,
    },
    {
      ...makeAssistantMessage("Older answer"),
    },
    {
      role: "user",
      content: `${skillBlock}\n\nNewest request`,
      timestamp: 3,
    },
  ];

  assert.equal(stripSkillBlocks(`${skillBlock}\n\nHello`), "Hello");
  assert.deepEqual(
    stripSkillBlocksFromMessage(history[0]!),
    {
      role: "user",
      content: "Older request",
      timestamp: 1,
    },
  );

  const strippedHistory = stripSkillBlocksFromHistory(history);
  assert.equal((strippedHistory[0] as Extract<AgentMessage, { role: "user" }>).content, "Older request");
  assert.equal((strippedHistory[2] as Extract<AgentMessage, { role: "user" }>).content, `${skillBlock}\n\nNewest request`);
});
