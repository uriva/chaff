import { assert, assertEquals } from "@std/assert";
import { pipe } from "gamla";
import { z } from "zod/v4";
import {
  compactToolResultsInMemory,
  type HistoryEvent,
  injectCallModel,
  injectCallModelWrapper,
  ownUtteranceTurn,
  participantUtteranceTurn,
  projectHistoryToModelContext,
  runAgent,
  type Skill,
  tool,
  type ToolOutputScratchPad,
  toolUseTurn,
  turnIterationBudgetWrapUpThought,
} from "../mod.ts";
import { injectGeminiToken } from "../src/gemini.ts";
import { genJsonOverride } from "../src/genJson.ts";
import { agentDeps } from "../test_helpers.ts";

Deno.test(
  "runAgent compacts oversized completed tool_call arguments while preserving scalar keys, scratchpad backup, and modelMetadata",
  async () => {
    const history: HistoryEvent[] = [
      {
        id: "u-1",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Write four large modules and confirm when finished.",
        timestamp: Date.now() - 10_000,
      },
    ];

    const scratchStorage = new Map<string, string>();
    const scratchPad: ToolOutputScratchPad = {
      get: (id: string) => Promise.resolve(scratchStorage.get(id)),
      set: (id: string, content: string) => {
        scratchStorage.set(id, content);
        return Promise.resolve();
      },
    };

    const bigBody = (idx: number) =>
      `// Module ${idx}\n` +
      `export const line = "large generated source payload block";\n`.repeat(
        350,
      ); // ~21KB per call

    const codeSkill: Skill = {
      name: "code_writer",
      description: "Write source files",
      instructions: "Use write_module to save source files.",
      tools: [
        tool({
          name: "write_module",
          description: "Write a source module to disk.",
          parameters: z.object({
            path: z.string(),
            content: z.string(),
          }),
          handler: ({ path }) => Promise.resolve(`Wrote ${path}`),
        }),
      ],
    };

    const seenHistories: HistoryEvent[][] = [];
    const state = { step: 0 };

    await pipe(
      injectCallModel((receivedHistory) => {
        seenHistories.push(JSON.parse(JSON.stringify(receivedHistory)));
        state.step++;
        if (state.step <= 4) {
          return Promise.resolve([
            {
              id: `write-call-${state.step}`,
              type: "tool_call",
              isOwn: true,
              name: "run_command",
              parameters: {
                command: "code_writer/write_module",
                params: {
                  path: `src/mod_${state.step}.ts`,
                  content: bigBody(state.step),
                },
              },
              modelMetadata: { thoughtSignature: `sig-${state.step}` },
              timestamp: Date.now(),
            },
          ]);
        }
        return Promise.resolve([ownUtteranceTurn("All 4 modules written.")]);
      }),
      agentDeps(history),
    )(() =>
      runAgent({
        provider: "moonshot",
        maxIterations: 10,
        tools: [],
        skills: [codeSkill],
        prompt: "You are a coding assistant.",
        toolOutputScratchPad: scratchPad,
        timezoneIANA: "UTC",
      })
    )();

    const finalModelHistory = seenHistories[seenHistories.length - 1] ?? [];
    const firstCall = finalModelHistory.find(
      (e): e is Extract<HistoryEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.id === "write-call-1",
    );
    assert(firstCall, "First tool_call must remain present in history");

    const serializedFirstArgs = JSON.stringify(firstCall.parameters);
    assert(
      serializedFirstArgs.length < 1_500,
      `Expected old completed tool_call parameters to be compacted (< 1,500 chars), got ${serializedFirstArgs.length} chars`,
    );
    assert(
      serializedFirstArgs.includes("code_writer/write_module"),
      "Compacted run_command tool_call must retain its command name",
    );
    assert(
      serializedFirstArgs.includes("src/mod_1.ts"),
      "Compacted tool_call must retain small scalar parameters like path",
    );
    assertEquals(
      firstCall.modelMetadata,
      { thoughtSignature: "sig-1" },
      "Compacted tool_call must preserve modelMetadata/thoughtSignature",
    );

    const scratchValues = [...scratchStorage.values()];
    assert(
      scratchValues.some((v) => v.includes("// Module 1")),
      "Original oversized tool_call arguments must be saved to scratchpad",
    );
  },
);

Deno.test(
  "runAgent rejects new tool calls that imitate a compacted-argument placeholder before invoking the handler",
  async () => {
    const history: HistoryEvent[] = [
      participantUtteranceTurn({
        name: "user",
        text: "Delegate the build task to a worker.",
      }),
    ];

    const invokedPrompts: string[] = [];
    const delegateTool = tool({
      name: "run_in_new_thread",
      description: "Delegate a task to a child thread",
      parameters: z.object({ prompt: z.string() }),
      handler: ({ prompt }) => {
        invokedPrompts.push(prompt);
        return Promise.resolve(
          `Spawned child thread with ${prompt.length} chars`,
        );
      },
    });

    const seenToolResults: string[] = [];
    const state = { step: 0 };

    await pipe(
      injectCallModel((receivedHistory) => {
        for (const e of receivedHistory) {
          if (e.type === "tool_result") {
            seenToolResults.push(e.result);
          }
        }
        state.step++;
        if (state.step === 1) {
          return Promise.resolve([
            toolUseTurn({
              id: "call-bad-placeholder",
              name: "run_in_new_thread",
              args: {
                prompt:
                  '[Compacted argument (3848 chars) — read full args via read_scratch_file("args-call_17607119070720092229")]',
              },
            }),
          ]);
        }
        if (state.step === 2) {
          return Promise.resolve([
            toolUseTurn({
              id: "call-good-prompt",
              name: "run_in_new_thread",
              args: {
                prompt: "Build and verify both PDFs cleanly.",
              },
            }),
          ]);
        }
        return Promise.resolve([
          ownUtteranceTurn("Delegated with full prompt."),
        ]);
      }),
      agentDeps(history),
    )(() =>
      runAgent({
        provider: "moonshot",
        maxIterations: 6,
        tools: [delegateTool],
        skills: [],
        prompt: "You are a helpful coordinator.",
        timezoneIANA: "UTC",
      })
    )();

    assertEquals(
      invokedPrompts,
      ["Build and verify both PDFs cleanly."],
      "Tool handler must never be invoked with a compacted-argument placeholder",
    );
    assert(
      seenToolResults.some((r) => r.includes("placeholder")),
      `Expected explicit validation error guiding the model to pass real content, got: ${
        JSON.stringify(seenToolResults)
      }`,
    );
  },
);

Deno.test(
  "hardMaxIterations injects wrap-up thought with tools disabled even when progress auditor keeps approving",
  async () => {
    const history: HistoryEvent[] = [
      participantUtteranceTurn({
        name: "user",
        text: "Search everything endlessly.",
      }),
    ];

    const searchTool = tool({
      name: "search_page",
      description: "Search a page",
      parameters: z.object({ page: z.number() }),
      handler: ({ page }) => Promise.resolve(`page ${page} results`),
    });

    const state = { calls: 0 };
    const seenDisableTools: Array<boolean | undefined> = [];

    await pipe(
      injectGeminiToken("fake-token"),
      genJsonOverride.inject(
        () =>
        (_opts: unknown, _sys: string, _zod: unknown) =>
        (): Promise<{ shouldContinue: boolean }> =>
          Promise.resolve({ shouldContinue: true }),
      ),
      injectCallModelWrapper(({ disableTools, inner }) => {
        seenDisableTools.push(disableTools);
        return inner;
      }),
      injectCallModel((events) => {
        state.calls++;
        const sawWrapUp = events.some(
          (e) =>
            e.type === "own_thought" &&
            e.text === turnIterationBudgetWrapUpThought,
        );
        if (sawWrapUp) {
          return Promise.resolve([
            ownUtteranceTurn("Wrapping up with findings so far."),
          ]);
        }
        return Promise.resolve([
          toolUseTurn({ name: "search_page", args: { page: state.calls } }),
        ]);
      }),
      agentDeps(history),
    )(() =>
      runAgent({
        maxIterations: 2,
        hardMaxIterations: 4,
        tools: [searchTool],
        prompt: "You are a researcher.",
        timezoneIANA: "UTC",
      })
    )();

    assertEquals(
      state.calls,
      4,
      `Expected runAgent to stop on wrap-up at hardMaxIterations=4, got ${state.calls} calls`,
    );
    assertEquals(
      seenDisableTools[seenDisableTools.length - 1],
      true,
      "Wrap-up call at hardMaxIterations must disable tools so model concludes",
    );
  },
);

Deno.test(
  "hardMaxIterations force-stops runaway loop if model ignores wrap-up thought",
  async () => {
    const history: HistoryEvent[] = [
      participantUtteranceTurn({
        name: "user",
        text: "Keep looping forever.",
      }),
    ];

    const searchTool = tool({
      name: "search_page",
      description: "Search a page",
      parameters: z.object({ page: z.number() }),
      handler: ({ page }) => Promise.resolve(`page ${page} results`),
    });

    const state = { calls: 0 };

    await pipe(
      injectGeminiToken("fake-token"),
      genJsonOverride.inject(
        () =>
        (_opts: unknown, _sys: string, _zod: unknown) =>
        (): Promise<{ shouldContinue: boolean }> =>
          Promise.resolve({ shouldContinue: true }),
      ),
      injectCallModel(() => {
        state.calls++;
        return Promise.resolve([
          toolUseTurn({ name: "search_page", args: { page: state.calls } }),
        ]);
      }),
      agentDeps(history),
    )(() =>
      runAgent({
        maxIterations: 2,
        hardMaxIterations: 4,
        tools: [searchTool],
        prompt: "You are a researcher.",
        timezoneIANA: "UTC",
      })
    )();

    assertEquals(
      state.calls,
      4,
      `Expected force-stop after wrap-up attempt at hardMaxIterations=4, got ${state.calls} calls`,
    );
  },
);

Deno.test(
  "mid-sized completed tool_call args stay immutable within the same turn to preserve prompt cache, then compact after 3 completed turns",
  async () => {
    const now = Date.now();
    const scratchStorage = new Map<string, string>();
    const scratchPad: ToolOutputScratchPad = {
      get: (id) => Promise.resolve(scratchStorage.get(id)),
      set: (id, content) => {
        scratchStorage.set(id, content);
        return Promise.resolve();
      },
    };
    const midSizedContent = "export const value = 42;\n".repeat(160); // ~4,000 chars (< 15k maxThreshold, > 1.5k minThreshold)
    const activeTurnHistory: HistoryEvent[] = [
      {
        id: "u-start",
        type: "participant_utterance",
        isOwn: false,
        name: "user",
        text: "Edit the file and verify with a few checks.",
        timestamp: now - 30_000,
      },
      {
        id: "write-mid-1",
        type: "tool_call",
        isOwn: true,
        name: "write_file",
        parameters: { path: "src/app.ts", content: midSizedContent },
        timestamp: now - 25_000,
      },
      {
        id: "write-mid-1-res",
        type: "tool_result",
        isOwn: true,
        toolCallId: "write-mid-1",
        result: "Wrote src/app.ts",
        timestamp: now - 24_000,
      },
      ...[1, 2, 3, 4].flatMap((n): HistoryEvent[] => [
        {
          id: `check-${n}`,
          type: "tool_call",
          isOwn: true,
          name: "run_check",
          parameters: { step: n },
          timestamp: now - 20_000 + n * 2_000,
        },
        {
          id: `check-${n}-res`,
          type: "tool_result",
          isOwn: true,
          toolCallId: `check-${n}`,
          result: `Check ${n} passed`,
          timestamp: now - 19_000 + n * 2_000,
        },
      ]),
    ];

    const projectedSameTurn = await projectHistoryToModelContext({
      rawHistory: activeTurnHistory,
      scratchPad,
    });
    const sameTurnCall = projectedSameTurn.find(
      (e): e is Extract<HistoryEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.id === "write-mid-1",
    );
    assert(sameTurnCall, "Expected write-mid-1 to remain in projected history");
    assertEquals(
      sameTurnCall.parameters,
      { path: "src/app.ts", content: midSizedContent },
      "Mid-sized tool_call args must not mutate mid-turn after 3+ tool steps (would bust prompt cache)",
    );

    const historyAfterThreeTurns: HistoryEvent[] = [
      ...activeTurnHistory,
      ...[1, 2, 3].flatMap((n): HistoryEvent[] => [
        {
          id: `reply-${n}`,
          type: "own_utterance",
          isOwn: true,
          text: `Done step ${n}.`,
          timestamp: now - 5_000 + n * 1_000,
        },
        {
          id: `followup-${n}`,
          type: "participant_utterance",
          isOwn: false,
          name: "user",
          text: `Thanks ${n}`,
          timestamp: now - 4_500 + n * 1_000,
        },
      ]),
    ];

    const projectedLater = await projectHistoryToModelContext({
      rawHistory: historyAfterThreeTurns,
      scratchPad,
    });
    const laterCall = projectedLater.find(
      (e): e is Extract<HistoryEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.id === "write-mid-1",
    );
    assert(laterCall, "Expected write-mid-1 to remain in later history");
    assert(
      JSON.stringify(laterCall.parameters).length < 1_500,
      "Expected mid-sized tool_call args to compact after 3 completed conversational turns",
    );
  },
);

Deno.test(
  "compactToolResultsInMemory skips wall-clock decay for events created during the active turn",
  async () => {
    const now = Date.now();
    const tenMinutesAgo = now - 10 * 60 * 1000;
    const scratchStorage = new Map<string, string>();
    const setScratch = (id: string, content: string): Promise<void> => {
      scratchStorage.set(id, content);
      return Promise.resolve();
    };
    const body = "a".repeat(8_000);
    const events: HistoryEvent[] = [
      {
        id: "call-long-turn",
        type: "tool_call",
        isOwn: true,
        name: "write_file",
        parameters: { path: "src/long.ts", content: body },
        timestamp: tenMinutesAgo + 1_000,
      },
      {
        id: "res-long-turn",
        type: "tool_result",
        isOwn: true,
        toolCallId: "call-long-turn",
        result: body,
        timestamp: tenMinutesAgo + 2_000,
      },
      {
        id: "call-next",
        type: "tool_call",
        isOwn: true,
        name: "bash",
        parameters: { command: "echo ok" },
        timestamp: now - 1_000,
      },
      {
        id: "res-next",
        type: "tool_result",
        isOwn: true,
        toolCallId: "call-next",
        result: "ok",
        timestamp: now - 500,
      },
    ];

    const compacted = await compactToolResultsInMemory(events, {
      setScratch,
      activeTurnStartedAt: tenMinutesAgo,
    });
    const callEvent = compacted.find(
      (e): e is Extract<HistoryEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.id === "call-long-turn",
    );
    const resEvent = compacted.find(
      (e): e is Extract<HistoryEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.id === "res-long-turn",
    );
    assertEquals(callEvent?.parameters, { path: "src/long.ts", content: body });
    assertEquals(resEvent?.result, body);
  },
);
