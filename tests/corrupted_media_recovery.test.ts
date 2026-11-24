import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Content, Part } from "@google/genai";
import { pipe } from "gamla";
import {
  callGeminiWithFixHistory,
  type GeminiHistoryEvent,
  injectGeminiSdkExchange,
} from "../src/geminiAgent.ts";

const corruptedMediaApiError = () =>
  new Error(
    '{"error":{"code":400,"message":"Unable to process input: the file or media data is empty, corrupted, or malformed.","status":"INVALID_ARGUMENT"}}',
  );

const extractRequestParts = (contents: unknown): Part[] =>
  Array.isArray(contents)
    ? (contents as Content[]).flatMap((c) => c.parts ?? [])
    : [];

Deno.test(
  "callGeminiWithFixHistory recovers from Gemini 400 'empty, corrupted, or malformed' by stripping older corrupted media while preserving the newest valid attachment",
  async () => {
    const corruptedUri =
      "https://generativelanguage.googleapis.com/v1beta/files/corrupted-old";
    const validUri =
      "https://generativelanguage.googleapis.com/v1beta/files/valid-new";

    const events: GeminiHistoryEvent[] = [
      {
        id: "ev-old-corrupted",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Earlier broken image",
        attachments: [
          {
            kind: "file",
            mimeType: "image/jpeg",
            fileUri: corruptedUri,
            caption: "old.jpg",
          },
        ],
        timestamp: 1_000,
      },
      {
        id: "ev-new-valid",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Now inspect this fresh valid image",
        attachments: [
          {
            kind: "file",
            mimeType: "image/jpeg",
            fileUri: validUri,
            caption: "fresh.jpg",
          },
        ],
        timestamp: 2_000,
      },
    ];

    const seenValidInFinalReq = { value: false };
    const exchangeAttempts = { count: 0 };

    const result = await pipe(
      injectGeminiSdkExchange((_signal, { req }) => {
        exchangeAttempts.count++;
        const parts = extractRequestParts(req.contents);
        const uris = parts
          .map((p) => p.fileData?.fileUri)
          .filter((u): u is string => Boolean(u));
        if (uris.includes(corruptedUri)) {
          return Promise.reject(corruptedMediaApiError());
        }
        seenValidInFinalReq.value = uris.includes(validUri);
        return Promise.resolve({
          parts: [{ text: "I can see the fresh image clearly." }],
          finishReason: "STOP",
        });
      }),
    )(() => callGeminiWithFixHistory()(events))();

    assertEquals(
      result.some(
        (p) =>
          p.type === "text" && p.text.includes("see the fresh image clearly"),
      ),
      true,
      "Expected recovery to succeed and return the model reply",
    );
    assert(
      seenValidInFinalReq.value,
      "Expected newest valid attachment to be preserved when stripping an older corrupted attachment",
    );
  },
);

Deno.test(
  "callGeminiWithFixHistory falls back to stripping corrupted inline and newest file attachments on 400 'empty, corrupted, or malformed'",
  async () => {
    const events: GeminiHistoryEvent[] = [
      {
        id: "ev-inline-corrupted",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Check this corrupted inline image",
        attachments: [
          {
            kind: "inline",
            mimeType: "image/png",
            dataBase64: "bm90LWEtdmFsaWQtcG5n",
            caption: "broken.png",
          },
        ],
        timestamp: 3_000,
      },
    ];

    const result = await pipe(
      injectGeminiSdkExchange((_signal, { req }) => {
        const parts = extractRequestParts(req.contents);
        const hasMedia = parts.some((p) => Boolean(p.inlineData || p.fileData));
        if (hasMedia) {
          return Promise.reject(corruptedMediaApiError());
        }
        return Promise.resolve({
          parts: [{
            text: "Recovered after stripping corrupted inline media.",
          }],
          finishReason: "STOP",
        });
      }),
    )(() => callGeminiWithFixHistory()(events))();

    assertEquals(
      result.some(
        (p) =>
          p.type === "text" &&
          p.text.includes("Recovered after stripping corrupted inline media"),
      ),
      true,
      "Expected recovery after stripping corrupted inline attachment",
    );
  },
);

Deno.test(
  "callGeminiWithFixHistory recovers from Gemini 400 unreachable GCS URL by stripping only the expired GCS attachment and keeping newer valid media",
  async () => {
    const expiredGcsUri =
      "https://storage.googleapis.com/example-bucket/attachments/expired-old.jpg";
    const freshGcsUri =
      "https://storage.googleapis.com/example-bucket/attachments/fresh-new.jpg";

    const events: GeminiHistoryEvent[] = [
      {
        id: "ev-expired-gcs",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Old expired attachment",
        attachments: [
          {
            kind: "file",
            mimeType: "image/jpeg",
            fileUri: expiredGcsUri,
            caption: "expired.jpg",
          },
        ],
        timestamp: 1_000,
      },
      {
        id: "ev-fresh-gcs",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Fresh attachment",
        attachments: [
          {
            kind: "file",
            mimeType: "image/jpeg",
            fileUri: freshGcsUri,
            caption: "fresh.jpg",
          },
        ],
        timestamp: 2_000,
      },
    ];

    const seenFresh = { value: false };
    const seenExpiredPlaceholder = { value: false };

    const result = await pipe(
      injectGeminiSdkExchange((_signal, { req }) => {
        const parts = extractRequestParts(req.contents);
        const uris = parts
          .map((p) => p.fileData?.fileUri)
          .filter((u): u is string => Boolean(u));
        if (uris.includes(expiredGcsUri)) {
          return Promise.reject(
            new Error(
              `{"error":{"code":400,"message":"Cannot fetch content from the provided URL: ${expiredGcsUri}","status":"INVALID_ARGUMENT"}}`,
            ),
          );
        }
        seenFresh.value = uris.includes(freshGcsUri);
        seenExpiredPlaceholder.value = parts.some(
          (p) =>
            typeof p.text === "string" &&
            p.text.includes("<media file expired: expired.jpg>"),
        );
        return Promise.resolve({
          parts: [{ text: "I see the fresh image." }],
          finishReason: "STOP",
        });
      }),
    )(() => callGeminiWithFixHistory()(events))();

    assertEquals(
      result.some((p) => p.type === "text" && p.text.includes("fresh image")),
      true,
    );
    assert(seenFresh.value, "Expected newer valid GCS attachment to remain");
    assert(
      seenExpiredPlaceholder.value,
      "Expected expired placeholder text in place of deleted GCS attachment",
    );
  },
);

Deno.test(
  "callGeminiWithFixHistory recovers from generic 404 NOT_FOUND on expired GCS attachment while preserving newest media",
  async () => {
    const expiredGcsUri =
      "https://storage.googleapis.com/example-bucket/attachments/deleted-404.jpg";
    const freshGcsUri =
      "https://storage.googleapis.com/example-bucket/attachments/still-live.jpg";

    const events: GeminiHistoryEvent[] = [
      {
        id: "ev-404-old",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Old attachment",
        attachments: [
          {
            kind: "file",
            mimeType: "image/jpeg",
            fileUri: expiredGcsUri,
            caption: "old404.jpg",
          },
        ],
        timestamp: 1_000,
      },
      {
        id: "ev-404-new",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "New attachment",
        attachments: [
          {
            kind: "file",
            mimeType: "image/jpeg",
            fileUri: freshGcsUri,
            caption: "live.jpg",
          },
        ],
        timestamp: 2_000,
      },
    ];

    const seenFresh = { value: false };

    const result = await pipe(
      injectGeminiSdkExchange((_signal, { req }) => {
        const parts = extractRequestParts(req.contents);
        const uris = parts
          .map((p) => p.fileData?.fileUri)
          .filter((u): u is string => Boolean(u));
        if (uris.includes(expiredGcsUri)) {
          const err = new Error(
            '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}',
          );
          Object.assign(err, { status: 404 });
          return Promise.reject(err);
        }
        seenFresh.value = uris.includes(freshGcsUri);
        return Promise.resolve({
          parts: [{ text: "Recovered after 404 on old GCS media." }],
          finishReason: "STOP",
        });
      }),
    )(() => callGeminiWithFixHistory()(events))();

    assertEquals(
      result.some(
        (p) => p.type === "text" && p.text.includes("Recovered after 404"),
      ),
      true,
    );
    assert(seenFresh.value, "Expected newest valid GCS attachment to remain");
  },
);

Deno.test(
  "callGeminiWithFixHistory does not swallow 404 NOT_FOUND when history has no file attachments",
  async () => {
    const events: GeminiHistoryEvent[] = [
      {
        id: "ev-text-only",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Hello",
        timestamp: 1_000,
      },
    ];

    await assertRejects(
      () =>
        pipe(
          injectGeminiSdkExchange(() => {
            const err = new Error(
              '{"error":{"code":404,"message":"models/unknown is not found","status":"NOT_FOUND"}}',
            );
            Object.assign(err, { status: 404 });
            return Promise.reject(err);
          }),
        )(() => callGeminiWithFixHistory()(events))(),
      Error,
      "NOT_FOUND",
    );
  },
);
