# chaff

**Cut the context bloat. A multi-party, time-aware agent harness for IM and
real-time voice.**

Most agent frameworks assume a single developer in a local terminal and charge a
heavy _harness tax_ in startup tokens, output verbosity, and config boilerplate.
`chaff` is built for agents that behave like humans digitally, living inside
WhatsApp, Telegram, group threads, and live voice calls, with zero config knobs
to babysit.

Website: **[chaff.uriv.me](https://chaff.uriv.me)**

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

## Terminal-Bench 4.1 spot-check (`gemini-4-hydrogen`, `k=1`)

To stress-test long multi-step trajectories, prompt caching, scratchpad spills,
and multimodal tool results on a held-constant model, we ran a 7-task `k=1`
spot-check on [Terminal-Bench 4.1](https://www.tbench.ai/) via Harbor on Modal
using a minimal 5-tool wrapper (`scripts/chaff_swe_agent.ts`,
`scripts/chaff_harbor_agent.py`) and compared five of those tasks head-to-head
against Google's `antigravity-cli`.

- **Pass rate:** **4/7** (`photonic-waveguide-routing`, `music-harmony`,
  `freecad-platform-drawing`, `payments-pipeline-fix`; `0.0` partial on
  `html-js-filter` 27/28 XSS batches vs. 3/28, `bun-sourcemap-leak` 28/37 vs.
  28/37, `interleaved-vigenere` 3/6 vs. timeout).
- **Prompt cache:** **82.7%–96.3%** cache hit across 21–71 LLM calls up to 237k
  context, with zero mid-turn cache busts after fixing mid-turn arg/decay
  mutation (`v0.4.2`) and scratchpad spill-notice length overflow (`v0.4.3`).
- **Scope:** Spot-check (`n=7`, `k=1`), not a full 66-task `k=5` leaderboard
  submission.

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
