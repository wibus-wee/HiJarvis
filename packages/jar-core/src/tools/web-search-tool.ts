import { Buffer } from "node:buffer";

import { Type, type TSchema, getEnvApiKey } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

import { convertHtmlToMarkdown } from "./web-fetch-tool.js";
import type { ToolOptions } from "./shared.js";

const webSearchQuerySchema = Type.Object({
  q: Type.String({
    description: "Search the web for a text query",
    minLength: 1,
  }),
  recency: Type.Optional(
    Type.Integer({
      description: "Optional recency window in days",
      minimum: 0,
    }),
  ),
  domains: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Optional domain allowlist for this query",
      minItems: 1,
    }),
  ),
}, {
  additionalProperties: false,
});

const webSearchParameters: TSchema = Type.Object({
  search_query: Type.Optional(
    Type.Array(webSearchQuerySchema, {
      description: "Search the web for one or more text queries",
      minItems: 1,
    }),
  ),
  image_query: Type.Optional(
    Type.Array(webSearchQuerySchema, {
      description: "Search the web for image-heavy results",
      minItems: 1,
    }),
  ),
  open: Type.Optional(
    Type.Array(Type.Object({
      ref_id: Type.String({
        description: "Open a URL or previously returned ref_id from search results",
        minLength: 1,
      }),
      lineno: Type.Optional(
        Type.Integer({
          description: "Optional line number hint inside the opened page",
          minimum: 0,
        }),
      ),
    }, {
      additionalProperties: false,
    }), {
      description: "Open one or more pages by ref_id or URL",
      minItems: 1,
    }),
  ),
  click: Type.Optional(
    Type.Array(Type.Object({
      ref_id: Type.String({
        description: "Page ref_id returned by an open action",
        minLength: 1,
      }),
      id: Type.Integer({
        description: "Link id from the active page",
        minimum: 1,
      }),
    }, {
      additionalProperties: false,
    }), {
      description: "Open a link from a previously opened page",
      minItems: 1,
    }),
  ),
  find: Type.Optional(
    Type.Array(Type.Object({
      ref_id: Type.String({
        description: "Page ref_id returned by an open action",
        minLength: 1,
      }),
      pattern: Type.String({
        description: "Find a text pattern inside the specified page",
        minLength: 1,
      }),
    }, {
      additionalProperties: false,
    }), {
      description: "Find a text pattern inside one or more pages",
      minItems: 1,
    }),
  ),
  screenshot: Type.Optional(
    Type.Array(Type.Object({
      ref_id: Type.String({
        description: "Page ref_id returned by an open action",
        minLength: 1,
      }),
      pageno: Type.Integer({
        description: "Page number to capture",
        minimum: 0,
      }),
    }, {
      additionalProperties: false,
    }), {
      description: "Return a synthetic snapshot image for one or more pages",
      minItems: 1,
    }),
  ),
  response_length: Type.Optional(
    Type.Union([
      Type.Literal("short"),
      Type.Literal("medium"),
      Type.Literal("long"),
    ], {
      description: "Desired response verbosity",
    }),
  ),
}, {
  additionalProperties: false,
});

type WebSearchQuery = {
  q: string;
  recency?: number;
  domains?: string[];
};

type WebSearchOpen = {
  ref_id: string;
  lineno?: number;
};

type WebSearchClick = {
  ref_id: string;
  id: number;
};

type WebSearchFind = {
  ref_id: string;
  pattern: string;
};

type WebSearchScreenshot = {
  ref_id: string;
  pageno: number;
};

type WebSearchParameters = {
  search_query?: WebSearchQuery[];
  image_query?: WebSearchQuery[];
  open?: WebSearchOpen[];
  click?: WebSearchClick[];
  find?: WebSearchFind[];
  screenshot?: WebSearchScreenshot[];
  response_length?: "short" | "medium" | "long";
};

type SearchReference = {
  refId: string;
  title: string;
  url: string;
};

type PageLink = {
  id: number;
  text: string;
  url: string;
};

type ActivePage = {
  url: string;
  title: string;
  text: string;
  excerpt: string;
  links: PageLink[];
};

type SearchSession = {
  searchResults: Map<string, SearchReference>;
  pages: Map<string, ActivePage>;
  nextResultId: number;
  nextPageId: number;
};

type OpenAIResponseOutputText = {
  type: "output_text";
  text: string;
  annotations?: Array<{
    type: string;
    title?: string;
    url?: string;
  }>;
};

type OpenAIWebSearchAction = {
  type: "search" | "open_page" | "find_in_page";
  query?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
  sources?: Array<{
    type: "url";
    url: string;
  }>;
};

type OpenAIResponsePayload = {
  output?: Array<
    | {
        type: "message";
        content?: OpenAIResponseOutputText[];
      }
    | {
        type: "web_search_call";
        id: string;
        status: string;
        action?: OpenAIWebSearchAction;
      }
    | Record<string, unknown>
  >;
};

type OpenAIResponseItem = NonNullable<OpenAIResponsePayload["output"]>[number];

const maxExcerptLength = 1_200;

export const createWebSearchTool = (
  options: ToolOptions,
): AgentTool<typeof webSearchParameters> => {
  const session: SearchSession = {
    searchResults: new Map(),
    pages: new Map(),
    nextResultId: 1,
    nextPageId: 1,
  };

  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web, open search results, inspect the active page, find text in-page, and capture a synthetic page snapshot. OpenAI uses the Responses web_search tool; other providers can plug in later.",
    parameters: webSearchParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as WebSearchParameters;
      const actions = collectActions(params);
      if (actions.length === 0) {
        throw new Error(
          "web_search requires one action: search_query, image_query, open, click, find, or screenshot.",
        );
      }

      const content: Array<TextContent | ImageContent> = [];
      const steps: Array<{ action: string; details: unknown }> = [];

      for (const action of actions) {
        if (action.type === "search") {
          const result = await runSearch(options, session, action, params.response_length);
          content.push(...result.content);
          steps.push({
            action: action.imageSearch ? "image_query" : "search_query",
            details: result.details,
          });
          continue;
        }
        if (action.type === "open") {
          const result = await openReferences(options, session, action.items);
          content.push(...result.content);
          steps.push({ action: "open", details: result.details });
          continue;
        }
        if (action.type === "click") {
          const result = await clickPageReferences(options, session, action.items);
          content.push(...result.content);
          steps.push({ action: "click", details: result.details });
          continue;
        }
        if (action.type === "find") {
          const result = await findInPages(session, action.items);
          content.push(...result.content);
          steps.push({ action: "find", details: result.details });
          continue;
        }
        const result = await capturePageSnapshots(session, action.items);
        content.push(...result.content);
        steps.push({ action: "screenshot", details: result.details });
      }

      return {
        content,
        details: steps.length === 1 ? steps[0]?.details : { steps },
      };
    },
  };
};

type WebSearchActionRequest =
  | { type: "search"; items: WebSearchQuery[]; imageSearch: boolean }
  | { type: "open"; items: WebSearchOpen[] }
  | { type: "click"; items: WebSearchClick[] }
  | { type: "find"; items: WebSearchFind[] }
  | { type: "screenshot"; items: WebSearchScreenshot[] };

const collectActions = (params: WebSearchParameters): WebSearchActionRequest[] => {
  const actions: WebSearchActionRequest[] = [];
  if (params.search_query && params.search_query.length > 0) {
    actions.push({ type: "search", items: params.search_query, imageSearch: false });
  }
  if (params.image_query && params.image_query.length > 0) {
    actions.push({ type: "search", items: params.image_query, imageSearch: true });
  }
  if (params.open && params.open.length > 0) {
    actions.push({ type: "open", items: params.open });
  }
  if (params.click && params.click.length > 0) {
    actions.push({ type: "click", items: params.click });
  }
  if (params.find && params.find.length > 0) {
    actions.push({ type: "find", items: params.find });
  }
  if (params.screenshot && params.screenshot.length > 0) {
    actions.push({ type: "screenshot", items: params.screenshot });
  }
  return actions;
};

const runSearch = async (
  options: ToolOptions,
  session: SearchSession,
  action: { items: WebSearchQuery[]; imageSearch: boolean },
  responseLength: "short" | "medium" | "long" | undefined,
): Promise<{ content: Array<TextContent | ImageContent>; details: unknown }> => {
  if (options.provider !== "openai") {
    return runNonOpenAISearch(options, session, action.items);
  }

  const searchSummaries: Array<{
    query: string;
    recency: number | null;
    domains: string[] | null;
    summary: string;
    results: SearchReference[];
  }> = [];

  for (const item of action.items) {
    const searchInput: {
      query: string;
      responseLength?: "short" | "medium" | "long";
      allowedDomains?: string[];
      recency?: number;
      imageSearch: boolean;
    } = {
      query: item.q,
      imageSearch: action.imageSearch,
    };
    if (responseLength !== undefined) {
      searchInput.responseLength = responseLength;
    }
    if (item.domains !== undefined) {
      searchInput.allowedDomains = item.domains;
    }
    if (item.recency !== undefined) {
      searchInput.recency = item.recency;
    }

    const payload = await callOpenAIWebSearch(options, searchInput);

    const messageTexts = extractOutputTexts(payload);
    const sources = extractSearchSources(payload);
    const results: SearchReference[] = sources.map((source) => ({
      refId: `result-${session.nextResultId++}`,
      title: source.title,
      url: source.url,
    }));

    for (const result of results) {
      session.searchResults.set(result.refId, result);
    }

    searchSummaries.push({
      query: item.q,
      recency: item.recency ?? null,
      domains: item.domains ?? null,
      summary: messageTexts.join("\n\n").trim() || "Search completed with no text summary.",
      results,
    });
  }

  const content = searchSummaries.map((summary) => {
    const sourceSummary =
      summary.results.length === 0
        ? "No explicit sources returned by the provider."
        : summary.results
            .map((source) => `[${source.refId}] ${source.title} - ${source.url}`)
            .join("\n");

    return createTextContent(
      [
        `Query: ${summary.query}`,
        `Mode: ${action.imageSearch ? "image_search" : "search"}`,
        `Response length: ${responseLength ?? "medium"}`,
        `Recency: ${summary.recency === null ? "none" : `${summary.recency} days`}`,
        `Domains: ${summary.domains === null ? "none" : summary.domains.join(", ")}`,
        "",
        summary.summary,
        "",
        "Sources:",
        sourceSummary,
      ].join("\n"),
    );
  });

  return {
    content,
    details: {
      provider: options.provider,
      model: options.model,
      responseLength: responseLength ?? "medium",
      searches: searchSummaries.map((summary) => ({
        query: summary.query,
        recency: summary.recency,
        domains: summary.domains,
        results: summary.results,
      })),
    },
  };
};

const openReferences = async (
  options: ToolOptions,
  session: SearchSession,
  items: WebSearchOpen[],
): Promise<{ content: Array<TextContent | ImageContent>; details: unknown }> => {
  const content: Array<TextContent | ImageContent> = [];
  const pages: Array<{ refId: string; url: string; title: string }> = [];

  for (const item of items) {
    const url = resolveSearchTarget(session, item.ref_id);
    const { pageRefId, page, linkCount } = await openUrl(options, session, url);
    pages.push({ refId: pageRefId, url: page.url, title: page.title });
    content.push(
      createTextContent(
        [
          `Opened: ${page.url}`,
          `Title: ${page.title}`,
          `Page ref_id: ${pageRefId}`,
          "",
          page.excerpt,
          "",
          linkCount === 0
            ? "No clickable links discovered on the page."
            : [
                "Page links:",
                ...page.links.map((link) => `[${link.id}] ${link.text} - ${link.url}`),
              ].join("\n"),
        ].join("\n"),
      ),
    );
  }

  return {
    content,
    details: {
      pages,
    },
  };
};

const clickPageReferences = async (
  options: ToolOptions,
  session: SearchSession,
  items: WebSearchClick[],
): Promise<{ content: Array<TextContent | ImageContent>; details: unknown }> => {
  const content: Array<TextContent | ImageContent> = [];
  const pages: Array<{ refId: string; url: string; title: string }> = [];

  for (const item of items) {
    const page = getPageOrThrow(session, item.ref_id);
    const link = page.links.find((candidate) => candidate.id === item.id);
    if (!link) {
      throw new Error(`Unknown page link id "${item.id}" for ref_id "${item.ref_id}".`);
    }

    const opened = await openUrl(options, session, link.url);
    pages.push({
      refId: opened.pageRefId,
      url: opened.page.url,
      title: opened.page.title,
    });
    content.push(
      createTextContent(
        [
          `Opened: ${opened.page.url}`,
          `Title: ${opened.page.title}`,
          `Page ref_id: ${opened.pageRefId}`,
          "",
          opened.page.excerpt,
          "",
          opened.linkCount === 0
            ? "No clickable links discovered on the page."
            : [
                "Page links:",
                ...opened.page.links.map(
                  (nextLink) => `[${nextLink.id}] ${nextLink.text} - ${nextLink.url}`,
                ),
              ].join("\n"),
        ].join("\n"),
      ),
    );
  }

  return {
    content,
    details: {
      pages,
    },
  };
};

const findInPages = async (
  session: SearchSession,
  items: WebSearchFind[],
): Promise<{ content: Array<TextContent | ImageContent>; details: unknown }> => {
  const content: Array<TextContent | ImageContent> = [];
  const results: Array<{ refId: string; pattern: string; matches: string[] }> = [];

  for (const item of items) {
    const page = getPageOrThrow(session, item.ref_id);
    const matches = findMatches(page.text, item.pattern);
    results.push({ refId: item.ref_id, pattern: item.pattern, matches });
    content.push(
      createTextContent(
        [
          `Find pattern: ${item.pattern}`,
          `URL: ${page.url}`,
          `Page ref_id: ${item.ref_id}`,
          `Matches: ${matches.length}`,
          "",
          matches.length === 0
            ? "No matches found."
            : matches.map((match, index) => `${index + 1}. ${match}`).join("\n\n"),
        ].join("\n"),
      ),
    );
  }

  return {
    content,
    details: {
      results,
    },
  };
};

const capturePageSnapshots = async (
  session: SearchSession,
  items: WebSearchScreenshot[],
): Promise<{ content: Array<TextContent | ImageContent>; details: unknown }> => {
  const content: Array<TextContent | ImageContent> = [];
  const snapshots: Array<{ refId: string; url: string; title: string; pageno: number }> = [];

  for (const item of items) {
    const page = getPageOrThrow(session, item.ref_id);
    const svg = renderPageSnapshotSvg(page);
    snapshots.push({
      refId: item.ref_id,
      url: page.url,
      title: page.title,
      pageno: item.pageno,
    });
    content.push(
      createTextContent(
        [
          "Synthetic page snapshot generated from fetched page content.",
          `URL: ${page.url}`,
          `Title: ${page.title}`,
          `Page ref_id: ${item.ref_id}`,
          `Page number: ${item.pageno}`,
        ].join("\n"),
      ),
      createImageContent(Buffer.from(svg, "utf8").toString("base64"), "image/svg+xml"),
    );
  }

  return {
    content,
    details: {
      snapshots,
    },
  };
};

const runNonOpenAISearch = async (
  options: ToolOptions,
  _session: SearchSession,
  queries: WebSearchQuery[],
) => {
  void queries;
  throw new Error(
    `web_search provider branch is not implemented for provider \"${options.provider}\". Add custom logic in runNonOpenAISearch() for custom queries.`,
  );
};

const callOpenAIWebSearch = async (
  options: ToolOptions,
  input: {
    query: string;
    responseLength?: "short" | "medium" | "long";
    allowedDomains?: string[];
    recency?: number;
    imageSearch: boolean;
  },
): Promise<OpenAIResponsePayload> => {
  const apiKey = options.providerApiKey ?? getEnvApiKey(options.provider);
  if (!apiKey) {
    throw new Error("OpenAI API key is required for web_search.");
  }

  const baseUrl = normalizeOpenAIBaseUrl(options.providerBaseUrl);
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      input: buildSearchPrompt(
        input.query,
        input.responseLength,
        input.recency,
        input.imageSearch,
      ),
      include: ["web_search_call.action.sources"],
      tools: [
        {
          type: "web_search",
          search_context_size: mapResponseLengthToContextSize(input.responseLength),
          ...(input.allowedDomains === undefined
            ? {}
            : {
                filters: {
                  allowed_domains: input.allowedDomains,
                },
              }),
        },
      ],
    }),
    signal: AbortSignal.timeout(options.webRequestTimeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI web_search failed with status ${response.status} ${response.statusText}: ${errorText.slice(0, 1000)}`,
    );
  }

  const payload = (await response.json()) as OpenAIResponsePayload;
  if (!payload.output) {
    throw new Error("OpenAI web_search returned no output.");
  }

  return payload;
};

const buildSearchPrompt = (
  query: string,
  responseLength: "short" | "medium" | "long" | undefined,
  recency: number | undefined,
  imageSearch: boolean,
): string => {
  const lengthInstruction =
    responseLength === "short"
      ? "Return a concise answer."
      : responseLength === "long"
        ? "Return a detailed answer with the most relevant findings."
        : "Return a balanced answer.";

  const recencyInstruction =
    recency === undefined ? "" : `Prefer results from the last ${recency} days.`;
  const modeInstruction = imageSearch ? "Prefer image-heavy results." : "";
  const instructions = [lengthInstruction, modeInstruction, recencyInstruction]
    .filter((value) => value.length > 0)
    .join("\n");

  return [instructions, `Search query: ${query}`].filter(Boolean).join("\n");
};

const mapResponseLengthToContextSize = (
  responseLength: "short" | "medium" | "long" | undefined,
): "low" | "medium" | "high" => {
  if (responseLength === "short") {
    return "low";
  }
  if (responseLength === "long") {
    return "high";
  }
  return "medium";
};

const normalizeOpenAIBaseUrl = (baseUrl: string | undefined): string => {
  if (!baseUrl) {
    return "https://api.openai.com/v1";
  }

  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
};

const extractOutputTexts = (payload: OpenAIResponsePayload): string[] => {
  return (payload.output ?? []).flatMap((item) => {
    if (!isMessageItem(item)) {
      return [];
    }
    return item.content
      .filter((content): content is OpenAIResponseOutputText => content.type === "output_text")
      .map((content) => content.text);
  });
};

const extractSearchSources = (
  payload: OpenAIResponsePayload,
): Array<{ title: string; url: string }> => {
  const sources = new Map<string, { title: string; url: string }>();

  for (const item of payload.output ?? []) {
    if (isWebSearchCallItem(item)) {
      for (const source of item.action?.sources ?? []) {
        if (!sources.has(source.url)) {
          sources.set(source.url, {
            title: source.url,
            url: source.url,
          });
        }
      }
      continue;
    }

    if (!isMessageItem(item)) {
      continue;
    }

    for (const content of item.content) {
      if (content.type !== "output_text") {
        continue;
      }
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== "url_citation" || !annotation.url) {
          continue;
        }
        sources.set(annotation.url, {
          title: annotation.title ?? annotation.url,
          url: annotation.url,
        });
      }
    }
  }

  return [...sources.values()];
};

const resolveSearchTarget = (session: SearchSession, target: string): string => {
  const ref = session.searchResults.get(target);
  return ref?.url ?? target;
};

const getPageOrThrow = (session: SearchSession, refId: string): ActivePage => {
  const page = session.pages.get(refId);
  if (!page) {
    throw new Error(`Unknown page ref_id "${refId}". Use open first.`);
  }
  return page;
};

const openUrl = async (
  options: ToolOptions,
  session: SearchSession,
  url: string,
): Promise<{ pageRefId: string; page: ActivePage; linkCount: number }> => {
  const page = await fetchAndParsePage(options, url);
  const pageRefId = `page-${session.nextPageId++}`;
  session.pages.set(pageRefId, page);
  return { pageRefId, page, linkCount: page.links.length };
};

const fetchAndParsePage = async (
  options: ToolOptions,
  url: string,
): Promise<ActivePage> => {
  const response = await fetch(url, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5",
      "User-Agent": "HiJarvis/0.1 (web.search)",
    },
    method: "GET",
    signal: AbortSignal.timeout(options.webRequestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Failed to open page: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "text/plain";
  const rawText = await response.text();
  const text = contentType.includes("html")
    ? convertHtmlToMarkdown(rawText, response.url)
    : normalizeWhitespace(rawText);
  const title = extractPageTitle(rawText) ?? response.url;
  const excerpt = text.slice(0, maxExcerptLength) || "Page content was empty.";

  return {
    url: response.url,
    title,
    text,
    excerpt,
    links: contentType.includes("html") ? extractPageLinks(rawText, response.url) : [],
  };
};

const extractPageTitle = (html: string): string | undefined => {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return undefined;
  }
  return decodeHtmlEntities(normalizeWhitespace(match[1]));
};

const extractPageLinks = (html: string, baseUrl: string): PageLink[] => {
  const linkPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const links: Array<{ text: string; url: string }> = [];
  let match: RegExpExecArray | null = null;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = extractAttribute(match[1] ?? "", "href");
    if (!href) {
      continue;
    }
    const text = decodeHtmlEntities(normalizeWhitespace(stripHtml(match[2] ?? "")));
    if (!text) {
      continue;
    }
    links.push({
      text,
      url: new URL(href, baseUrl).toString(),
    });
  }
  return dedupePageLinks(links)
    .slice(0, 25)
    .map((link, index) => ({
      id: index + 1,
      text: link.text,
      url: link.url,
    }));
};

const extractAttribute = (attributes: string, name: string): string | undefined => {
  const match = attributes.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
};

const dedupePageLinks = (
  links: Array<{ text: string; url: string }>,
): Array<{ text: string; url: string }> => {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.text}::${link.url}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const stripHtml = (value: string): string => value.replace(/<[^>]+>/g, " ");

const normalizeWhitespace = (value: string): string => {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
};

const decodeHtmlEntities = (value: string): string => {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
};

const findMatches = (text: string, pattern: string): string[] => {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedText = text.toLowerCase();
  const matches: string[] = [];
  let offset = 0;
  while (matches.length < 5) {
    const index = normalizedText.indexOf(normalizedPattern, offset);
    if (index === -1) {
      break;
    }
    const start = Math.max(0, index - 120);
    const end = Math.min(text.length, index + pattern.length + 120);
    matches.push(text.slice(start, end).trim());
    offset = index + normalizedPattern.length;
  }
  return matches;
};

const renderPageSnapshotSvg = (page: ActivePage): string => {
  const lines = [page.title, page.url, "", ...page.excerpt.split("\n").slice(0, 10)];
  const escapedLines = lines.map((line) => escapeXml(line.slice(0, 110)));
  const textNodes = escapedLines
    .map(
      (line, index) =>
        `<text x="32" y="${56 + index * 28}" font-size="18" fill="#0f172a">${line}</text>`,
    )
    .join("");

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">',
    '<rect width="1200" height="900" fill="#f8fafc" />',
    '<rect x="20" y="20" width="1160" height="860" rx="16" fill="#ffffff" stroke="#cbd5e1" />',
    '<circle cx="56" cy="52" r="8" fill="#ef4444" />',
    '<circle cx="84" cy="52" r="8" fill="#f59e0b" />',
    '<circle cx="112" cy="52" r="8" fill="#22c55e" />',
    '<text x="140" y="58" font-size="18" fill="#475569">Synthetic page snapshot</text>',
    textNodes,
    '</svg>',
  ].join("");
};

const escapeXml = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

const createTextContent = (text: string): TextContent => ({
  type: "text",
  text,
});

const createImageContent = (data: string, mimeType: string): ImageContent => ({
  type: "image",
  data,
  mimeType,
});

const isMessageItem = (
  item: OpenAIResponseItem,
): item is { type: "message"; content: OpenAIResponseOutputText[] } => {
  return item.type === "message";
};

const isWebSearchCallItem = (
  item: OpenAIResponseItem,
): item is { type: "web_search_call"; id: string; status: string; action?: OpenAIWebSearchAction } => {
  return item.type === "web_search_call";
};
