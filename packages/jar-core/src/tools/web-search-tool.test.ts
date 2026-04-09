import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { ToolOptions } from "./shared.js";
import { createWebSearchTool } from "./web-search-tool.js";

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
  return firstContent?.type === "text" ? firstContent.text : "";
};

test("web_search performs an OpenAI-backed search and returns result refs", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");

    return new Response(
      JSON.stringify({
        output: [
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: {
              type: "search",
              query: "jarvis docs",
              sources: [
                {
                  type: "url",
                  url: "https://example.com/docs",
                },
              ],
            },
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Jarvis docs summary",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Jarvis Docs",
                    url: "https://example.com/docs",
                  },
                ],
              },
            ],
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  });

  const tool = createWebSearchTool(toolOptions);
  const result = await tool.execute("call-1", {
    search_query: [
      {
        q: "jarvis docs",
      },
    ],
    response_length: "short",
  });
  const text = getTextResult(result);

  assert.match(text, /Jarvis docs summary/);
  assert.match(text, /\[result-1\] Jarvis Docs - https:\/\/example.com\/docs/);
});

test("web_search opens a search result and supports find plus screenshot", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === "https://api.openai.com/v1/responses") {
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Search result",
                  annotations: [
                    {
                      type: "url_citation",
                      title: "Example Docs",
                      url: "https://example.com/docs",
                    },
                  ],
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }

    assert.equal(String(input), "https://example.com/docs");
    const response = new Response(
      `
        <html>
          <head><title>Example Docs</title></head>
          <body>
            <h1>Install Jarvis</h1>
            <p>Installation steps are simple and clear.</p>
            <a href="/install">Install Guide</a>
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
      value: "https://example.com/docs",
    });
    return response;
  });

  const tool = createWebSearchTool(toolOptions);
  await tool.execute("call-1", {
    search_query: [
      {
        q: "jarvis install",
      },
    ],
  });

  const openResult = await tool.execute("call-2", { open: [{ ref_id: "result-1" }] });
  assert.match(getTextResult(openResult), /\[1\] Install Guide - https:\/\/example.com\/install/);

  const findResult = await tool.execute("call-3", {
    find: [
      {
        ref_id: "page-1",
        pattern: "installation",
      },
    ],
  });
  assert.match(getTextResult(findResult), /Matches: 1/);

  const screenshotResult = await tool.execute("call-4", {
    screenshot: [
      {
        ref_id: "page-1",
        pageno: 0,
      },
    ],
  });
  assert.equal(screenshotResult.content[1]?.type, "image");
  if (screenshotResult.content[1]?.type === "image") {
    assert.equal(screenshotResult.content[1].mimeType, "image/svg+xml");
  }
});

test("web_search leaves a non-openai extension seam", async () => {
  const tool = createWebSearchTool({
    ...toolOptions,
    provider: "anthropic",
  });

  await assert.rejects(
    () =>
      tool.execute("call-1", {
        search_query: [
          {
            q: "jarvis",
          },
        ],
      }),
    /not implemented for provider "anthropic"/,
  );
});
