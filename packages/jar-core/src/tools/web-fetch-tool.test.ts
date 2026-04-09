import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { ToolOptions } from "./shared.js";
import { convertHtmlToMarkdown, createWebFetchTool } from "./web-fetch-tool.js";

const toolOptions: ToolOptions = {
  provider: "openai",
  model: "gpt-4o-mini",
  workspaceRoot: path.join(path.sep, "tmp", "jar-workspace"),
  maxFileBytes: 32_768,
  commandTimeoutMs: 30_000,
  maxCommandOutputBytes: 32_768,
  webRequestTimeoutMs: 30_000,
  maxWebResponseBytes: 32_768,
};

const getTextResult = (result: {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}): string => {
  const firstContent = result.content[0];
  return firstContent?.type === "text" && "text" in firstContent
    ? firstContent.text
    : "";
};

test("convertHtmlToMarkdown keeps headings, links, and lists readable", () => {
  const markdown = convertHtmlToMarkdown(
    `
      <html>
        <head><title>Example</title></head>
        <body>
          <h1>Hello</h1>
          <p>Visit <a href="/docs">the docs</a>.</p>
          <ul><li>Fast</li><li>Local</li></ul>
        </body>
      </html>
    `,
    "https://example.com/guide",
  );

  assert.match(markdown, /^# Hello/m);
  assert.match(markdown, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.match(markdown, /^- Fast$/m);
  assert.match(markdown, /^- Local$/m);
});

test("createWebFetchTool converts HTML responses into markdown output", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://example.com/page");

      const requestHeaders = new Headers(init?.headers);
      assert.equal(requestHeaders.get("x-request-id"), "req-123");
      assert.equal(
        requestHeaders.get("user-agent"),
        "HiJarvis/0.1 (web.fetch)",
      );

      const response = new Response(
        `
          <html>
            <head><title>Example page</title></head>
            <body>
              <h1>Hello</h1>
              <p>Read <a href="/docs">the docs</a>.</p>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );

      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://example.com/page",
      });

      return response;
    },
  );

  const tool = createWebFetchTool(toolOptions);
  const result = await tool.execute("call-1", {
    url: "https://example.com/page",
    headers: {
      "X-Request-Id": "req-123",
    },
  });
  const text = getTextResult(result);

  assert.match(text, /Format: markdown/);
  assert.match(text, /^# Hello/m);
  assert.match(text, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.deepEqual(result.details, {
    requestedUrl: "https://example.com/page",
    finalUrl: "https://example.com/page",
    status: 200,
    contentType: "text/html; charset=utf-8",
    byteLength: Buffer.byteLength(
      `
          <html>
            <head><title>Example page</title></head>
            <body>
              <h1>Hello</h1>
              <p>Read <a href="/docs">the docs</a>.</p>
            </body>
          </html>
        `,
      "utf8",
    ),
    format: "markdown",
    timeoutMs: 30_000,
  });
});

test("createWebFetchTool returns plain text for json responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  const tool = createWebFetchTool(toolOptions);
  const result = await tool.execute("call-2", {
    url: "https://example.com/data.json",
  });
  const text = getTextResult(result);

  assert.match(text, /Format: text/);
  assert.match(text, /\{"ok":true\}/);
});

test("createWebFetchTool rejects non-text and oversized responses", async (t) => {
  const tool = createWebFetchTool({
    ...toolOptions,
    maxWebResponseBytes: 8,
  });

  t.mock.method(globalThis, "fetch", async () => {
    return new Response("hello world", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "11",
      },
    });
  });

  await assert.rejects(
    () =>
      tool.execute("call-3", {
        url: "https://example.com/notes.txt",
      }),
    /Response is too large/,
  );
});

test("createWebFetchTool rejects unsupported protocols", async () => {
  const tool = createWebFetchTool(toolOptions);

  await assert.rejects(
    () =>
      tool.execute("call-4", {
        url: "file:///tmp/example.txt",
      }),
    /Only http and https are allowed/,
  );
});
