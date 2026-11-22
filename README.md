# chaff

**Cut the context bloat. A multi-party, time-aware agent harness for IM and
real-time voice.**

Most agent frameworks assume a single developer in a local terminal and charge a
heavy _harness tax_ in startup tokens, output verbosity, and config boilerplate.
`chaff` is built for agents that behave like humans digitally, living inside
WhatsApp, Telegram, group threads, and live voice calls, with zero config knobs
to babysit.

Website & benchmarks: **[chaff.uriv.me](https://chaff.uriv.me)**

## Why chaff

- **Multi-party native:** Typed event log for named speakers
  (`participant_utterance`), replies, edits, reactions, async `external_event`
  callbacks, and first-class silence (`do_nothing`) so agents know when _not_ to
  speak in a group chat.
- **Time-aware:** Timestamps and `timezoneIANA` on every turn, natural session
  segmentation on conversation gaps, idle skill auto-unlearning, and turn
  execution time budgets.
- **One harness for IM and real-time voice:** The exact same `AgentSpec`, tools,
  skills, and history run across text/IM (Gemini, Anthropic, Kimi with automatic
  safety-block fallback) and full-duplex live audio
  (`transport: { kind: "audio" }`) with barge-in handling.
- **Economical & dynamic without knobs:** Dynamic skill loading and unlearning,
  per-turn thinking-level routing, three-tier compaction (in-memory tool-result
  folding, scratchpad spills, settled-session rollups), deterministic cache
  prefixes, and zero-cost-on-happy-path reliability guards.

## Benchmarks (same model: `gemini-3.8-flash`)

| Benchmark                                     | Metric                | chaff  | Baseline | Delta       |
| --------------------------------------------- | --------------------- | ------ | -------- | ----------- |
| ClawBench `t2-config-loader` vs. Pi           | Output tokens         | 944    | 8,711    | **-89.2%**  |
| ClawBench `t2-config-loader` vs. Pi           | Total tokens          | 120.9k | 248.8k   | **-51.4%**  |
| ClawBench `t2-config-loader` vs. Pi           | LLM calls             | 16     | 36       | **-55.5%**  |
| Turn-1 startup tax vs. Pi                     | Initial tokens        | ~800   | 4,239    | **-81.1%**  |
| τ-bench Retail (5/5) vs. reference `LLMAgent` | Output tokens         | 1,137  | 3,406    | **-66.6%**  |
| τ-bench Retail (5/5) vs. reference `LLMAgent` | Prompt cache hit rate | 55.2%  | 0%       | **+55.2pp** |

## Install

```bash
npm install @uriv/chaff
```

Works in Node (>= 20), Bun, Cloudflare Workers (`nodejs_compat`), and Deno
(`npm:@uriv/chaff`).

## Running an agent

```ts
import {
  injectAccessHistory,
  injectGeminiToken,
  injectOutputEvent,
  participantUtteranceTurn,
  runAgent,
  tool,
  z,
} from "@uriv/chaff";

const history = [
  participantUtteranceTurn({
    name: "Alice",
    text: "What's the weather in Tokyo?",
  }),
];

const getWeather = tool({
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: z.object({ city: z.string() }),
  handler: async ({ city }) => ({
    result: JSON.stringify({ city, tempC: 22, condition: "sunny" }),
  }),
});

await injectGeminiToken(process.env.GEMINI_API_KEY!)(
  injectAccessHistory(async () => history)(
    injectOutputEvent(async (event) => {
      history.push(event);
    })(async () => {
      await runAgent({
        prompt: "You are a concise participant in a group chat.",
        tools: [getWeather],
        maxIterations: 5,
        timezoneIANA: "UTC",
      });
    }),
  ),
)();
```

## Real-time voice

Run the same agent over full-duplex audio via Gemini Live:

```ts
import { createDuplexPair, runAgent } from "@uriv/chaff";

const [agentSide, callerSide] = createDuplexPair();

await runAgent({
  prompt: "You are a helpful voice participant.",
  tools: [],
  maxIterations: 10,
  timezoneIANA: "UTC",
  transport: {
    kind: "audio",
    endpoint: agentSide,
    voiceName: "Aoede",
    participantName: "Caller",
  },
});
```

## Structured JSON output

```ts
import { genJson, injectGeminiToken, z } from "@uriv/chaff";

const extract = genJson(
  { provider: "google", tier: "flash" },
  "Extract the person's name and age from the text.",
  z.object({ name: z.string(), age: z.number() }),
);

const result = await injectGeminiToken(process.env.GEMINI_API_KEY!)(
  () => extract("My name is Alice and I'm 30."),
)();
// { name: "Alice", age: 30 }
```

## Development

```bash
deno task check      # fmt, lint, typecheck
deno task test       # run test suite
deno task build-npm  # build npm package into ./npm
```

## License

MIT
