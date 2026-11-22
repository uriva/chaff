const traces = {
  im: {
    meta: "Asia/Jerusalem · 3 speakers",
    telemetry: [
      "turn-1: ~800 tok",
      "skills loaded: 1 / 14",
      "cache hit: 55.2%",
    ],
    events: [
      {
        kind: "msg",
        speaker: "Maya",
        time: "09:14",
        text: "Running 10 minutes late, grabbing coffee on the way.",
      },
      {
        kind: "msg",
        speaker: "Dan",
        time: "09:15",
        text: "No rush, grab me an iced americano if you can.",
      },
      {
        kind: "system",
        tone: "silent",
        text: "do_nothing · Maya and Dan are talking to each other, staying silent",
      },
      {
        kind: "gap",
        text: "34 min gap · segment settled, prior context eligible for compaction",
      },
      {
        kind: "msg",
        speaker: "Dan",
        time: "09:49",
        text: "@bot check if Thursday 14:00 works for everyone and send the invite.",
      },
      {
        kind: "system",
        tone: "route",
        text: "decision router · thinking=HIGH · loaded skill: calendar (13 idle skills omitted)",
      },
      {
        kind: "msg",
        speaker: "chaff agent",
        time: "09:49",
        agent: true,
        text: "Maya has a conflict until 14:30. Moved it to 14:30 and sent invites to both of you.",
      },
    ],
  },
  voice: {
    meta: "Gemini Live · full-duplex 24kHz PCM",
    telemetry: [
      "transport: audio",
      "barge-in: enabled",
      "same AgentSpec + tools",
    ],
    events: [
      {
        kind: "msg",
        speaker: "Caller (audio)",
        time: "14:02:04",
        text: "Hey, can you check my order from last Tuesday and tell me if it shipped?",
      },
      {
        kind: "system",
        tone: "route",
        text: "tool_call orders/get_status · silent execution, zero spoken narration",
      },
      {
        kind: "msg",
        speaker: "chaff agent (audio)",
        time: "14:02:06",
        agent: true,
        text: "Yep, order #4821 left the warehouse yesterday morning and is scheduled for...",
      },
      {
        kind: "system",
        tone: "silent",
        text: "barge-in detected · flushed outgoing PCM buffer cleanly",
      },
      {
        kind: "msg",
        speaker: "Caller (audio)",
        time: "14:02:09",
        text: "Actually can you change the drop-off note to leave it by the side gate?",
      },
      {
        kind: "system",
        tone: "route",
        text: "tool_call orders/update_note · confirmed before speaking",
      },
      {
        kind: "msg",
        speaker: "chaff agent (audio)",
        time: "14:02:11",
        agent: true,
        text: "Done, updated the delivery note to side gate.",
      },
    ],
  },
};

const snippets = {
  im: `import {
  injectAccessHistory,
  injectGeminiToken,
  injectOutputEvent,
  participantUtteranceTurn,
  runAgent,
  tool,
  z,
} from "chaff";

const history = [
  participantUtteranceTurn({ name: "Maya", text: "Grabbing coffee, brb" }),
  participantUtteranceTurn({ name: "Dan", text: "@bot what's the weather in Tokyo?" }),
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
        timezoneIANA: "Asia/Jerusalem",
      });
    }),
  ),
)();`,
  voice: `import { createDuplexPair, injectGeminiToken, runAgent } from "chaff";

const [agentSide, callerSide] = createDuplexPair();

await injectGeminiToken(process.env.GEMINI_API_KEY!)(async () => {
  await runAgent({
    prompt: "You are a concise voice participant. Speak naturally.",
    tools: [getOrderStatus, updateDeliveryNote],
    maxIterations: 10,
    timezoneIANA: "UTC",
    transport: {
      kind: "audio",
      endpoint: agentSide,
      voiceName: "Aoede",
      participantName: "Caller",
    },
  });
})();`,
  json: `import { genJson, injectGeminiToken, z } from "chaff";

const extractContact = genJson(
  { provider: "google", tier: "flash" },
  "Extract the person's name and timezone from the message.",
  z.object({
    name: z.string(),
    timezone: z.string(),
  }),
);

const result = await injectGeminiToken(process.env.GEMINI_API_KEY!)(
  () => extractContact("Hey, I'm Maya calling from Tel Aviv."),
)();`,
};

const timelineEl = document.getElementById("stage-timeline");
const metaEl = document.getElementById("stage-meta");
const telemetryEl = document.getElementById("stage-telemetry");
const codeBlockEl = document.getElementById("code-block");
const copyInstallBtn = document.getElementById("copy-install");
const installStatusEl = document.getElementById("install-status");
const copySnippetBtn = document.getElementById("copy-snippet");
const replayBtn = document.getElementById("stage-replay");

let currentMode = "im";
let currentSnippet = "im";

const renderTrace = (mode) => {
  currentMode = mode;
  const trace = traces[mode];
  metaEl.textContent = trace.meta;
  telemetryEl.innerHTML = trace.telemetry
    .map((item) => `<span>${item}</span>`)
    .join("");

  timelineEl.innerHTML = "";
  trace.events.forEach((ev, index) => {
    const el = document.createElement("div");
    el.className = "trace-item";
    el.style.animationDelay = `${index * 95}ms`;

    if (ev.kind === "gap") {
      el.classList.add("trace-gap");
      el.textContent = ev.text;
    } else if (ev.kind === "system") {
      el.classList.add("trace-system");
      if (ev.tone === "silent") el.classList.add("is-silent");
      if (ev.tone === "route") el.classList.add("is-route");
      el.textContent = ev.text;
    } else {
      el.classList.add("trace-msg");
      if (ev.agent) el.classList.add("is-agent");
      el.innerHTML = `
        <div class="trace-head">
          <span class="trace-speaker">${ev.speaker}</span>
          <span class="trace-time">${ev.time}</span>
        </div>
        <div class="trace-text">${ev.text}</div>
      `;
    }
    timelineEl.appendChild(el);
  });
};

const renderSnippet = (name) => {
  currentSnippet = name;
  codeBlockEl.textContent = snippets[name];
};

document.querySelectorAll(".stage-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".stage-tab").forEach((other) => {
      other.classList.remove("is-active");
      other.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    renderTrace(btn.dataset.mode);
  });
});

replayBtn.addEventListener("click", () => renderTrace(currentMode));

document.querySelectorAll(".code-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".code-tab").forEach((other) =>
      other.classList.remove("is-active")
    );
    btn.classList.add("is-active");
    renderSnippet(btn.dataset.snippet);
  });
});

copyInstallBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("npm install chaff");
    installStatusEl.textContent = "copied";
    setTimeout(() => {
      installStatusEl.textContent = "copy";
    }, 1600);
  } catch {
    installStatusEl.textContent = "npm install chaff";
  }
});

copySnippetBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(snippets[currentSnippet]);
    copySnippetBtn.textContent = "Copied";
    setTimeout(() => {
      copySnippetBtn.textContent = "Copy";
    }, 1600);
  } catch {
    copySnippetBtn.textContent = "Failed";
  }
});

renderTrace("im");
renderSnippet("im");
