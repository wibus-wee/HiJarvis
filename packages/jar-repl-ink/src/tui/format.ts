import cliTruncate from "cli-truncate";
import wrapAnsi from "wrap-ansi";

export const truncateLine = (value: string, width: number): string => {
  const normalized = normalizeWhitespace(value);
  if (width <= 0 || normalized.length === 0) {
    return "";
  }

  return cliTruncate(normalized, width, { position: "end" });
};

export const clampBlock = (
  value: string,
  options: {
    width: number;
    maxLines: number;
  },
): string[] => {
  const normalized = normalizeBlock(value);
  if (normalized.length === 0 || options.width <= 0 || options.maxLines <= 0) {
    return [];
  }

  const wrappedLines = wrapAnsi(normalized, options.width, {
    hard: true,
    trim: false,
    wordWrap: true,
  })
    .split("\n")
    .map((line) => line.trimEnd());

  if (wrappedLines.length <= options.maxLines) {
    return wrappedLines;
  }

  const visibleLines = wrappedLines.slice(0, options.maxLines);
  const lastLineIndex = visibleLines.length - 1;
  visibleLines[lastLineIndex] = cliTruncate(`${visibleLines[lastLineIndex] ?? ""}…`, options.width, {
    position: "end",
    space: false,
  });

  return visibleLines;
};

const normalizeWhitespace = (value: string): string => {
  return value.replace(/\s+/g, " ").trim();
};

const normalizeBlock = (value: string): string => {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
};
