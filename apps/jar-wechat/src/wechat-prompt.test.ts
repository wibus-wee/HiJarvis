import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWeChatPrompt,
  sanitizePersistedConversationMessage,
  type WeChatMessage,
  type WeChatPromptAsset,
} from "./wechat-prompt.js";

test("buildWeChatPrompt renders bundled messages and image references", () => {
  const messages: WeChatMessage[] = [{
    id: "msg-1",
    userId: "wx-user",
    sentAt: new Date("2026-04-07T12:00:00.000Z"),
    type: "image",
    attachments: [{
      id: "msg-1#1",
      kind: "image",
      url: "https://example.com/screenshot.png",
      transcriptText: "[image] https://example.com/screenshot.png",
    }],
    transcriptText: "[image] https://example.com/screenshot.png",
  }, {
    id: "msg-2",
    userId: "wx-user",
    sentAt: new Date("2026-04-07T12:00:01.000Z"),
    type: "text",
    text: "Check the error in the screenshot.",
    attachments: [],
    transcriptText: "Check the error in the screenshot.",
  }];

  const assets: WeChatPromptAsset[] = [{
    reference: "IMG-1",
    messageId: "msg-1",
    url: "https://example.com/screenshot.png",
    included: true,
  }];

  const prompt = buildWeChatPrompt({
    messages,
    assets,
    imageInputEnabled: true,
  });

  assert.match(prompt, /short coalescing window/);
  assert.match(prompt, /IMG-1: attached from https:\/\/example\.com\/screenshot\.png/);
  assert.match(prompt, /\(image\): \[image\] https:\/\/example\.com\/screenshot\.png/);
  assert.match(prompt, /\(text\): Check the error in the screenshot\./);
});

test("sanitizePersistedConversationMessage strips image blocks from stored user messages", () => {
  const sanitized = sanitizePersistedConversationMessage({
    role: "user",
    timestamp: Date.now(),
    content: [{
      type: "text",
      text: "Please inspect this screenshot.",
    }, {
      type: "image",
      data: "ZmFrZS1pbWFnZQ==",
      mimeType: "image/png",
    }],
  });

  assert.deepEqual(sanitized, {
    role: "user",
    timestamp: sanitized.timestamp,
    content: [{
      type: "text",
      text: "Please inspect this screenshot.",
    }],
  });
});
