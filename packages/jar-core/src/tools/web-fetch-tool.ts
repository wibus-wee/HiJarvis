import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ToolOptions } from "./shared.js";

const defaultRequestHeaders = {
  Accept:
    "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5",
  "User-Agent": "HiJarvis/0.1 (web.fetch)",
} satisfies Record<string, string>;

const webFetchParameters: TSchema = Type.Object({
  url: Type.String({
    description: "Absolute http or https URL to fetch with GET",
    minLength: 1,
  }),
  headers: Type.Optional(
    Type.Record(
      Type.String({ minLength: 1 }),
      Type.String({
        description: "Request header value",
      }),
    ),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Optional request timeout in milliseconds",
      minimum: 1,
    }),
  ),
});

type WebFetchParameters = {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

type WebFetchFormat = "markdown" | "text";

const additionalTextContentTypes = new Set([
  "application/atom+xml",
  "application/json",
  "application/ld+json",
  "application/problem+json",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
  "application/javascript",
  "image/svg+xml",
]);

export const createWebFetchTool = (
  options: ToolOptions,
): AgentTool<typeof webFetchParameters> => {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a remote page or text document with HTTP GET. HTML is converted into markdown-like text when possible.",
    parameters: webFetchParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as WebFetchParameters;
      const requestUrl = parseHttpUrl(params.url);
      const timeoutMs = params.timeoutMs ?? options.webRequestTimeoutMs;
      const headers = {
        ...defaultRequestHeaders,
        ...(params.headers ?? {}),
      };

      try {
        const response = await fetch(requestUrl, {
          headers,
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(
            `Request failed with status ${response.status} ${response.statusText}`,
          );
        }

        const contentType =
          response.headers.get("content-type") ?? "application/octet-stream";
        if (!isTextLikeContentType(contentType)) {
          throw new Error(`Unsupported content type "${contentType}". web_fetch only supports text-like responses.`);
        }

        const declaredLength = parseContentLength(
          response.headers.get("content-length"),
        );
        if (
          declaredLength !== undefined &&
          declaredLength > options.maxWebResponseBytes
        ) {
          throw new Error(
            `Response is too large (${declaredLength} bytes). Limit: ${options.maxWebResponseBytes} bytes`,
          );
        }

        const responseText = await response.text();
        const byteLength = Buffer.byteLength(responseText, "utf8");
        if (byteLength > options.maxWebResponseBytes) {
          throw new Error(
            `Response is too large (${byteLength} bytes). Limit: ${options.maxWebResponseBytes} bytes`,
          );
        }

        const format: WebFetchFormat = isHtmlContentType(contentType)
          ? "markdown"
          : "text";
        const body =
          format === "markdown"
            ? convertHtmlToMarkdown(responseText, response.url)
            : normalizePlainText(responseText);

        return {
          content: [
            {
              type: "text",
              text: [
                `URL: ${response.url}`,
                `Content-Type: ${contentType}`,
                `Format: ${format}`,
                `Status: ${response.status}`,
                "",
                body || "Response body was empty.",
              ].join("\n"),
            },
          ],
          details: {
            requestedUrl: requestUrl.toString(),
            finalUrl: response.url,
            status: response.status,
            contentType,
            byteLength,
            format,
            timeoutMs,
          },
        };
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new Error(`Request timed out after ${timeoutMs} ms`);
        }

        throw error;
      }
    },
  };
};

const parseHttpUrl = (input: string): URL => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error(`Invalid URL "${input}"`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(
      `Unsupported URL protocol "${parsedUrl.protocol}". Only http and https are allowed.`,
    );
  }

  return parsedUrl;
};

const parseContentLength = (value: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const isTextLikeContentType = (contentType: string): boolean => {
  const mediaType = getMediaType(contentType);
  return mediaType.startsWith("text/") || additionalTextContentTypes.has(mediaType);
};

const isHtmlContentType = (contentType: string): boolean => {
  const mediaType = getMediaType(contentType);
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
};

const getMediaType = (contentType: string): string => {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
};

const isTimeoutError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      (error.name === "AbortError" && error.message.includes("timeout")))
  );
};

export const convertHtmlToMarkdown = (
  html: string,
  baseUrl?: string,
): string => {
  const title = extractTitle(html);

  let markdown = html
    .replace(/\r\n?/g, "\n")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, "");

  markdown = replaceImageTags(markdown, baseUrl);
  markdown = replaceAnchorTags(markdown, baseUrl);
  markdown = replacePreformattedBlocks(markdown);
  markdown = replaceInlineCodeTags(markdown);
  markdown = replaceStrongTags(markdown);
  markdown = replaceEmphasisTags(markdown);
  markdown = replaceHeadingTags(markdown);
  markdown = replaceBlockquoteTags(markdown);
  markdown = replaceListItemTags(markdown);
  markdown = markdown
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(
      /<(p|div|section|article|main|header|footer|nav|aside|figure|figcaption|table|tr|ul|ol)[^>]*>/gi,
      "\n\n",
    )
    .replace(/<\/(p|div|section|article|main|header|footer|nav|aside|figure|figcaption|table|tr)>/gi, "\n\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<\/(td|th)>/gi, "")
    .replace(/<[^>]+>/g, "");

  markdown = cleanupMarkdown(markdown);

  if (markdown.length > 0) {
    return markdown;
  }

  return title ? `# ${title}` : "";
};

const replaceImageTags = (html: string, baseUrl?: string): string => {
  return html.replace(/<img\b([^>]*)>/gi, (_match, attributes: string) => {
    const src = extractAttributeValue(attributes, "src");
    if (!src) {
      return "";
    }

    const alt = extractAttributeValue(attributes, "alt") ?? "image";
    return `![${escapeMarkdownInline(decodeHtmlEntities(alt))}](${resolveUrl(src, baseUrl)})`;
  });
};

const replaceAnchorTags = (html: string, baseUrl?: string): string => {
  return html.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, attributes: string, innerHtml: string) => {
      const href = extractAttributeValue(attributes, "href");
      const text = htmlFragmentToText(innerHtml);

      if (!href) {
        return text;
      }

      const resolvedHref = resolveUrl(href, baseUrl);
      return text ? `[${escapeMarkdownInline(text)}](${resolvedHref})` : resolvedHref;
    },
  );
};

const replacePreformattedBlocks = (html: string): string => {
  const withCodeBlocks = html.replace(
    /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, innerHtml: string) => {
      const code = decodeHtmlEntities(innerHtml)
        .replace(/\r\n?/g, "\n")
        .trimEnd();
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    },
  );

  return withCodeBlocks.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, innerHtml: string) => {
      const code = decodeHtmlEntities(innerHtml)
        .replace(/\r\n?/g, "\n")
        .trimEnd();
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    },
  );
};

const replaceInlineCodeTags = (html: string): string => {
  return html.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, innerHtml: string) => `\`${htmlFragmentToText(innerHtml)}\``,
  );
};

const replaceStrongTags = (html: string): string => {
  return html.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tagName: string, innerHtml: string) =>
      `**${htmlFragmentToText(innerHtml)}**`,
  );
};

const replaceEmphasisTags = (html: string): string => {
  return html.replace(
    /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tagName: string, innerHtml: string) =>
      `*${htmlFragmentToText(innerHtml)}*`,
  );
};

const replaceHeadingTags = (html: string): string => {
  let nextValue = html;

  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    const pattern = new RegExp(
      `<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`,
      "gi",
    );
    nextValue = nextValue.replace(pattern, (_match, innerHtml: string) => {
      const text = htmlFragmentToText(innerHtml);
      return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "\n\n";
    });
  }

  return nextValue;
};

const replaceBlockquoteTags = (html: string): string => {
  return html.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_match, innerHtml: string) => {
      const text = htmlFragmentToText(innerHtml, { preserveLineBreaks: true });
      if (!text) {
        return "\n\n";
      }

      const quotedText = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `\n\n${quotedText}\n\n`;
    },
  );
};

const replaceListItemTags = (html: string): string => {
  return html.replace(
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    (_match, innerHtml: string) => {
      const text = htmlFragmentToText(innerHtml);
      return text ? `- ${text}\n` : "";
    },
  );
};

const htmlFragmentToText = (
  value: string,
  options: { preserveLineBreaks?: boolean } = {},
): string => {
  const normalized = decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  if (options.preserveLineBreaks) {
    return normalized
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return normalized
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
};

const cleanupMarkdown = (value: string): string => {
  return decodeHtmlEntities(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const normalizePlainText = (value: string): string => {
  return value.replace(/\r\n?/g, "\n").trim();
};

const extractTitle = (html: string): string => {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1];
  return title ? htmlFragmentToText(title) : "";
};

const extractAttributeValue = (
  attributes: string,
  attributeName: string,
): string | undefined => {
  const pattern = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const match = attributes.match(pattern);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlEntities(value) : undefined;
};

const resolveUrl = (value: string, baseUrl?: string): string => {
  if (!baseUrl) {
    return value;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
};

const escapeMarkdownInline = (value: string): string => {
  return value.replace(/([\\`*_{}\[\]()#+.!|>\-])/g, "\\$1");
};

const decodeHtmlEntities = (value: string): string => {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity, token: string) => {
      const normalizedToken = token.toLowerCase();

      switch (normalizedToken) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return "\"";
        case "apos":
          return "'";
        case "nbsp":
          return "\u00a0";
        default:
          if (normalizedToken.startsWith("#x")) {
            const codePoint = Number.parseInt(normalizedToken.slice(2), 16);
            return Number.isNaN(codePoint)
              ? entity
              : String.fromCodePoint(codePoint);
          }

          if (normalizedToken.startsWith("#")) {
            const codePoint = Number.parseInt(normalizedToken.slice(1), 10);
            return Number.isNaN(codePoint)
              ? entity
              : String.fromCodePoint(codePoint);
          }

          return entity;
      }
    },
  );
};
