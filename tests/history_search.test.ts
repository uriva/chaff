import { assert, assertEquals } from "@std/assert";
import {
  type HistoryEvent,
  injectCallModel,
  ownThoughtTurn,
  ownUtteranceTurn,
  participantUtteranceTurn,
  runAgent,
  searchPastHistoryToolName,
  toolResultTurn,
  toolUseTurn,
} from "../mod.ts";
import { searchPastHistoryToolRaw } from "../src/historySearch.ts";
import {
  cleanActiveMemoryToolName,
  setThinkingLevelToolName,
} from "../src/utils.ts";
import { agentDeps, runForAllProviders } from "../test_helpers.ts";

const createSampleHistory = (): HistoryEvent[] => {
  const baseTime = 1788500000000;
  return [
    {
      ...participantUtteranceTurn({
        name: "Alice",
        text: "Can you help me book a flight to Paris for next Friday?",
      }),
      timestamp: baseTime + 1000,
    },
    {
      ...ownThoughtTurn(
        "User wants flight booking to Paris. Searching flight database.",
      ),
      timestamp: baseTime + 2000,
    },
    {
      ...toolUseTurn({
        name: "search_flights",
        args: { destination: "CDG", date: "2026-10-02" },
      }),
      id: "call-flight-search",
      timestamp: baseTime + 3000,
    },
    {
      ...toolResultTurn({
        toolCallId: "call-flight-search",
        result:
          "Found 2 options: Air France AF123 ($450, departs 08:00) and EasyJet U2456 ($210, departs 14:30).",
      }),
      timestamp: baseTime + 4000,
    },
    {
      ...ownUtteranceTurn(
        "I found two flights to Paris: AF123 for $450 and U2456 for $210.",
      ),
      timestamp: baseTime + 5000,
    },
    {
      ...participantUtteranceTurn({
        name: "Alice",
        text: "Please book flight AF123 for me.",
      }),
      timestamp: baseTime + 60000,
    },
    {
      ...toolUseTurn({
        name: "book_ticket",
        args: {
          flight: "AF123",
          passenger: "Alice",
          confirmationCode: "CONF-987654",
        },
      }),
      id: "call-book",
      timestamp: baseTime + 61000,
    },
    {
      ...toolResultTurn({
        toolCallId: "call-book",
        result:
          "Booking successful! Order confirmation code: CONF-987654. Seat 14B reserved.",
      }),
      timestamp: baseTime + 62000,
    },
    {
      ...ownUtteranceTurn(
        "Booked! Your confirmation code is CONF-987654 for flight AF123.",
      ),
      timestamp: baseTime + 63000,
    },
  ];
};

Deno.test("searchPastHistoryToolRaw - searches by keyword across utterances, thoughts, and tools", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const result = await searchTool.handler({
    query: "AF123",
    order: "asc",
    limit: 20,
    offset: 0,
  });

  assert(
    typeof result === "string" && result.includes("Found 5 matching events"),
    `Expected 5 matches for AF123, got: ${result}`,
  );
  assert(result.includes("AF123 ($450"));
  assert(result.includes("CONF-987654"));
});

Deno.test("searchPastHistoryToolRaw - case-insensitive regex search", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const result = await searchTool.handler({
    query: "(?i)easyjet",
    order: "asc",
    limit: 20,
    offset: 0,
  });

  assert(
    typeof result === "string" && result.includes("Found 1 matching events"),
    `Expected 1 match for EasyJet, got: ${result}`,
  );
  assert(result.includes("EasyJet U2456"));
});

Deno.test("searchPastHistoryToolRaw - filters by event type", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const result = await searchTool.handler({
    types: ["participant_utterance"],
    order: "asc",
    limit: 20,
    offset: 0,
  });

  assert(
    typeof result === "string" && result.includes("Found 2 matching events"),
    `Expected 2 participant utterances, got: ${result}`,
  );
  assert(result.includes("Alice"));
  assert(!result.includes("AF123 ($450"));
});

Deno.test("searchPastHistoryToolRaw - filters by time range", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const baseTime = 1788500000000;
  const startTime = new Date(baseTime + 55000).toISOString();
  const endTime = new Date(baseTime + 70000).toISOString();

  const result = await searchTool.handler({
    start_time: startTime,
    end_time: endTime,
    order: "asc",
    limit: 20,
    offset: 0,
  });

  assert(
    typeof result === "string" && result.includes("Found 4 matching events"),
    `Expected 4 events in time window, got: ${result}`,
  );
  assert(result.includes("CONF-987654"));
  assert(!result.includes("Can you help me book a flight to Paris"));
});

Deno.test("searchPastHistoryToolRaw - handles pagination with limit and offset", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const page1 = await searchTool.handler({
    order: "asc",
    limit: 3,
    offset: 0,
  });

  assert(
    typeof page1 === "string" &&
      page1.includes(
        "Found 9 matching events (showing 3 events from offset 0)",
      ),
    `Expected page 1 of 3 events, got: ${page1}`,
  );
  assert(page1.includes("6 more matching events available"));

  const page2 = await searchTool.handler({
    order: "asc",
    limit: 3,
    offset: 3,
  });

  assert(
    typeof page2 === "string" &&
      page2.includes(
        "Found 9 matching events (showing 3 events from offset 3)",
      ),
    `Expected page 2 of 3 events, got: ${page2}`,
  );
});

Deno.test("searchPastHistoryToolRaw - returns clean message when no events match", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const result = await searchTool.handler({
    query: "NonExistentKeywordXYZ",
    order: "asc",
    limit: 20,
    offset: 0,
  });

  assertEquals(
    result,
    "No past conversation events matched your search criteria.",
  );
});

Deno.test("searchPastHistoryToolRaw - rejects invalid start_time cleanly", async () => {
  const history = createSampleHistory();
  const searchTool = searchPastHistoryToolRaw(() => Promise.resolve(history));

  const result = await searchTool.handler({
    start_time: "not-a-valid-date",
    order: "asc",
    limit: 20,
    offset: 0,
  });

  assert(
    typeof result === "string" &&
      result.includes("Invalid date format for start_time"),
    `Expected date validation error, got: ${result}`,
  );
});

Deno.test("searchPastHistoryTool - agent can call tool to retrieve past facts", async () => {
  const sampleHistory = createSampleHistory();
  const history: HistoryEvent[] = [
    ...sampleHistory,
    {
      ...participantUtteranceTurn({
        name: "Alice",
        text: "What was my flight confirmation code from earlier?",
      }),
      timestamp: 1788500000000 + 120000,
    },
  ];

  let toolWasCalled = false;

  const fakeCallModel = (received: HistoryEvent[]): Promise<HistoryEvent[]> => {
    const lastEvent = received[received.length - 1];
    if (lastEvent.type === "participant_utterance") {
      return Promise.resolve([
        toolUseTurn({
          name: searchPastHistoryToolName,
          args: { query: "confirmation" },
        }),
      ]);
    }
    if (lastEvent.type === "tool_result") {
      toolWasCalled = true;
      assert(
        typeof lastEvent.result === "string" &&
          lastEvent.result.includes("CONF-987654"),
        `Tool result did not contain expected confirmation code: ${lastEvent.result}`,
      );
      return Promise.resolve([
        ownUtteranceTurn(
          "Your flight confirmation code is CONF-987654 for flight AF123.",
        ),
      ]);
    }
    return Promise.resolve([]);
  };

  await injectCallModel(fakeCallModel)(async () => {
    await agentDeps(history)(runAgent)({
      provider: "anthropic",
      maxIterations: 3,
      tools: [],
      prompt: "You are a helpful assistant.",
      timezoneIANA: "UTC",
    });
  })();

  assert(toolWasCalled, "Expected search_past_history tool to be called");
  const finalUtterance = history[history.length - 1];
  assert(
    finalUtterance.type === "own_utterance" &&
      finalUtterance.text.includes("CONF-987654"),
    `Expected final utterance with confirmation code, got: ${
      JSON.stringify(finalUtterance)
    }`,
  );
});

runForAllProviders(
  "agent recovers raw details via search_past_history when prior tool results were compacted into a summary",
  async (runAgent) => {
    const rawHistory: HistoryEvent[] = [
      participantUtteranceTurn({
        name: "user",
        text: "Please generate a server license key.",
      }),
      {
        id: "call-license-1",
        type: "tool_call",
        name: "generate_license",
        parameters: { product: "enterprise-server" },
        timestamp: 1700000002000,
        isOwn: true,
      },
      {
        id: "res-license-1",
        type: "tool_result",
        result:
          "SUCCESS: Generated license key: KEY-8822-PROD-UNCOMPACT-99. Saved to /etc/license.key",
        timestamp: 1700000002500,
        isOwn: true,
        toolCallId: "call-license-1",
      },
      {
        id: "msg-bot-1",
        type: "own_utterance",
        text: "I have generated your server license key and saved it.",
        timestamp: 1700000003000,
        isOwn: true,
      },
      {
        id: "call-clean-1",
        type: "tool_call",
        name: cleanActiveMemoryToolName,
        parameters: {
          start_time: new Date(1700000002000).toISOString(),
          end_time: new Date(1700000002500).toISOString(),
          summary: "Generated server license and saved to file.",
        },
        timestamp: 1700000004000,
        isOwn: true,
      },
      {
        id: "res-clean-1",
        type: "tool_result",
        result: `Successfully summarized 2 events from ${
          new Date(1700000002000).toISOString()
        } to ${
          new Date(1700000002500).toISOString()
        } with summary: "Generated server license and saved to file."`,
        timestamp: 1700000004001,
        isOwn: true,
        toolCallId: "call-clean-1",
      },
      participantUtteranceTurn({
        name: "user",
        text:
          "What was the exact license key string that was generated earlier?",
      }),
    ];

    await agentDeps(rawHistory)(runAgent)({
      maxIterations: 3,
      tools: [],
      prompt: "You are a helpful assistant.",
      timezoneIANA: "UTC",
    });

    const calledSearch = rawHistory.some((e) =>
      e.type === "tool_call" && e.name === searchPastHistoryToolName
    );
    const lastUtterance = [...rawHistory].reverse().find((e) =>
      e.type === "own_utterance"
    );
    const recoveredKey = lastUtterance?.text?.includes(
      "KEY-8822-PROD-UNCOMPACT-99",
    );

    assert(
      calledSearch,
      "Agent should call search_past_history when info is compacted away",
    );
    assert(
      recoveredKey,
      `Agent should recover exact key from raw history. Last utterance: ${lastUtterance?.text}`,
    );
  },
  3,
  true, // Gemini-only: relies on search_past_history tool call resolution
);

Deno.test("search_past_history guides model to own_thought when types filter misses PROACTIVE TASK notifications", async () => {
  const ts = Date.parse("2026-11-17T09:51:08.908Z");
  const history: HistoryEvent[] = [
    {
      id: "pt-1",
      type: "own_thought",
      isOwn: true,
      text:
        "PROACTIVE TASK: You have a task to complete: Urgent alert for client.",
      timestamp: ts,
    },
  ];
  const tool = searchPastHistoryToolRaw(() => Promise.resolve(history));
  const missWithParticipantType = await tool.handler({
    start_time: "2026-11-17T00:00:00Z",
    types: ["participant_utterance"],
    order: "desc",
    limit: 5,
  });
  assert(
    missWithParticipantType.includes("own_thought: 1"),
    `Expected hint about matching own_thought events, got: ${missWithParticipantType}`,
  );
  const hitWithoutTypes = await tool.handler({
    start_time: "2026-11-17T00:00:00Z",
    order: "desc",
    limit: 5,
  });
  assert(
    hitWithoutTypes.includes("Urgent alert for client."),
    `Expected full proactive task text when omitting types, got: ${hitWithoutTypes}`,
  );
});

Deno.test("search_past_history omits internal bookkeeping tools and ranks/filters summaries by end timestamp", async () => {
  const day1 = Date.parse("2026-11-11T16:00:00Z");
  const morningEnd = Date.parse("2026-11-19T05:46:00Z");
  const evening = Date.parse("2026-11-19T19:52:00Z");
  const history: HistoryEvent[] = [
    {
      id: `summary-${day1}-${morningEnd}`,
      type: "own_thought",
      isOwn: true,
      text:
        "[This summary covers Nov 11 to Nov 19]\n\nDiscussed Show Alpha and Show Beta.",
      timestamp: day1,
    },
    {
      ...toolUseTurn({
        name: setThinkingLevelToolName,
        args: { level: "low" },
      }),
      id: "call-think-1",
      timestamp: evening - 2000,
    },
    {
      ...toolResultTurn({ toolCallId: "call-think-1", result: "ok" }),
      timestamp: evening - 1900,
    },
    {
      ...toolUseTurn({
        name: cleanActiveMemoryToolName,
        args: {
          start_time: "2026-11-19T05:00:00Z",
          end_time: "2026-11-19T06:00:00Z",
          summary: "cleaned",
        },
      }),
      id: "call-clean-1",
      timestamp: evening - 1500,
    },
    {
      ...toolResultTurn({ toolCallId: "call-clean-1", result: "cleaned" }),
      timestamp: evening - 1400,
    },
    {
      ...toolUseTurn({
        name: searchPastHistoryToolName,
        args: { order: "desc", limit: 20 },
      }),
      id: "call-search-self",
      timestamp: evening,
    },
  ];

  const tool = searchPastHistoryToolRaw(() => Promise.resolve(history));
  const result = await tool.handler({
    start_time: "2026-11-19T00:00:00Z",
    order: "desc",
    limit: 20,
    offset: 0,
  });

  assert(
    result.includes("Found 1 matching events"),
    `Expected only the non-bookkeeping summary event, got: ${result}`,
  );
  assert(
    result.includes("Show Alpha and Show Beta"),
    `Expected summary overlapping start_time to be returned, got: ${result}`,
  );
  assert(!result.includes(setThinkingLevelToolName));
  assert(!result.includes(cleanActiveMemoryToolName));
  assert(!result.includes(searchPastHistoryToolName));
});

Deno.test("search_past_history does not self-match the planning thought emitted alongside the search call", async () => {
  const baseTime = 1788600000000;
  const history: HistoryEvent[] = [
    {
      ...participantUtteranceTurn({
        name: "Alice",
        text: "Did we ever share a demo-video link earlier?",
      }),
      timestamp: baseTime,
    },
    {
      id: "thought-substantive",
      type: "own_thought",
      isOwn: true,
      text:
        "Substantive prior turn thought: noted invoice INV-404 while answering Alice.",
      timestamp: baseTime + 1000,
      modelMetadata: { type: "gemini", responseId: "resp-substantive" },
    },
    {
      id: "utt-substantive",
      type: "own_utterance",
      isOwn: true,
      text: "I noted invoice INV-404.",
      timestamp: baseTime + 1000,
      modelMetadata: { type: "gemini", responseId: "resp-substantive" },
    },
  ];

  let step = 0;
  const fakeCallModel = (): Promise<HistoryEvent[]> => {
    step += 1;
    if (step === 1) {
      return Promise.resolve([
        {
          id: "call-search-video",
          type: "tool_call",
          isOwn: true,
          name: searchPastHistoryToolName,
          parameters: { query: "demo-video.example" },
          timestamp: baseTime + 5000,
          modelMetadata: { type: "gemini", responseId: "resp-search-1" },
        },
        {
          id: "thought-search-video",
          type: "own_thought",
          isOwn: true,
          text:
            "I should search past history for demo-video.example to see if a link was shared.",
          timestamp: baseTime + 5000,
          modelMetadata: { type: "gemini", responseId: "resp-search-1" },
        },
      ]);
    }
    if (step === 2) {
      return Promise.resolve([
        {
          id: "call-search-inv",
          type: "tool_call",
          isOwn: true,
          name: searchPastHistoryToolName,
          parameters: { query: "INV-404" },
          timestamp: baseTime + 6000,
          modelMetadata: { type: "gemini", responseId: "resp-search-2" },
        },
        {
          id: "thought-search-inv",
          type: "own_thought",
          isOwn: true,
          text: "Checking history for INV-404.",
          timestamp: baseTime + 6000,
          modelMetadata: { type: "gemini", responseId: "resp-search-2" },
        },
      ]);
    }
    return Promise.resolve([
      {
        ...ownUtteranceTurn("Done checking history."),
        timestamp: baseTime + 7000,
      },
    ]);
  };

  await injectCallModel(fakeCallModel)(async () => {
    await agentDeps(history)(runAgent)({
      provider: "google",
      maxIterations: 5,
      tools: [],
      prompt: "You are a helpful assistant.",
      timezoneIANA: "UTC",
    });
  })();

  const videoResult = history.find(
    (e): e is Extract<HistoryEvent, { type: "tool_result" }> =>
      e.type === "tool_result" && e.toolCallId === "call-search-video",
  );
  assert(videoResult, "Expected tool_result for call-search-video");
  assertEquals(
    videoResult.result,
    "No past conversation events matched your search criteria.",
  );

  const invResult = history.find(
    (e): e is Extract<HistoryEvent, { type: "tool_result" }> =>
      e.type === "tool_result" && e.toolCallId === "call-search-inv",
  );
  assert(invResult, "Expected tool_result for call-search-inv");
  assert(
    typeof invResult.result === "string" &&
      invResult.result.includes(
        "Substantive prior turn thought: noted invoice INV-404",
      ),
    `Expected substantive thought to remain searchable, got: ${invResult.result}`,
  );
  assert(
    typeof invResult.result === "string" &&
      !invResult.result.includes("Checking history for INV-404"),
    `Expected search-planning thought to be excluded, got: ${invResult.result}`,
  );
});

Deno.test("search_past_history returns full untruncated payload on full=true or single-event match and spills >20k events to scratchpad", async () => {
  const baseTime = 1788700000000;
  const tailMarker = "FINAL_ITEM_50_UUID_99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const longLines = Array.from(
    { length: 220 },
    (_, i) =>
      `Item ${i + 1}: conversation_id=00000000-0000-4000-8000-${
        String(i + 1).padStart(12, "0")
      } status=needs-review details=${"x".repeat(80)}`,
  );
  const longPayload = `[external event]: Batch Audit\n${
    longLines.join("\n")
  }\n${tailMarker}`;
  const history: HistoryEvent[] = [
    {
      id: "ext-long-0",
      type: "own_thought",
      isOwn: true,
      text: longPayload,
      timestamp: baseTime,
    },
    {
      ...participantUtteranceTurn({
        name: "Operator",
        text: "Please inspect all items.",
      }),
      id: "msg-1",
      timestamp: baseTime + 1000,
    },
  ];

  const tool = searchPastHistoryToolRaw(() => Promise.resolve(history));
  const multiSnippet = await tool.handler({ order: "asc", limit: 10 });
  assert(
    multiSnippet.includes("full=true"),
    `Expected truncation hint mentioning full=true, got: ${multiSnippet}`,
  );

  const singleFull = await tool.handler({ order: "asc", limit: 1 });
  assert(
    singleFull.includes(tailMarker),
    `Expected single-event result to include full tail marker, got len=${singleFull.length}`,
  );

  const explicitFull = await tool.handler({
    order: "asc",
    limit: 10,
    full: true,
  });
  assert(
    explicitFull.includes(tailMarker),
    `Expected full=true result to include full tail marker, got len=${explicitFull.length}`,
  );

  // Verify through runAgent that >20k output spills cleanly into scratchPad
  const scratchStore = new Map<string, string>();
  const scratchPad = {
    set: (id: string, value: string) => {
      scratchStore.set(id, value);
      return Promise.resolve();
    },
    get: (id: string) => Promise.resolve(scratchStore.get(id)),
  };
  let step = 0;
  const fakeCallModel = (): Promise<HistoryEvent[]> => {
    step += 1;
    if (step === 1) {
      return Promise.resolve([
        {
          id: "call-search-full",
          type: "tool_call",
          isOwn: true,
          name: searchPastHistoryToolName,
          parameters: { order: "asc", limit: 1, full: true },
          timestamp: baseTime + 5000,
        },
      ]);
    }
    return Promise.resolve([
      {
        ...ownUtteranceTurn("Recovered full payload."),
        timestamp: baseTime + 6000,
      },
    ]);
  };

  await injectCallModel(fakeCallModel)(async () => {
    await agentDeps(history)(runAgent)({
      provider: "google",
      maxIterations: 4,
      tools: [],
      prompt: "You are a helpful assistant.",
      timezoneIANA: "UTC",
      toolOutputScratchPad: scratchPad,
    });
  })();

  const spilled = scratchStore.get("call-search-full");
  assert(
    typeof spilled === "string" && spilled.includes(tailMarker),
    `Expected >20k search_past_history result to spill complete payload to scratchpad, got len=${spilled?.length}`,
  );
});
