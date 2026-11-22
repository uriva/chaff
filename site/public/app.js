const scripts = {
  im: [
    {
      kind: "human",
      speaker: "Maya",
      time: "09:14",
      text: "Running 10 mins late, grabbing coffee on the way.",
      delayMs: 300,
    },
    {
      kind: "human",
      speaker: "Dan",
      time: "09:15",
      text: "No rush, grab me an iced americano if you can.",
      delayMs: 1100,
    },
    {
      kind: "meta",
      text: "do_nothing · stayed silent",
      delayMs: 750,
    },
    {
      kind: "meta",
      text: "34 min gap · prior segment compacted",
      delayMs: 1100,
    },
    {
      kind: "human",
      speaker: "Dan",
      time: "09:49",
      text: "@bot check if Thursday 14:00 works for both of us and send the invite.",
      delayMs: 1200,
    },
    {
      kind: "meta",
      text: "thinking=HIGH · loaded skill: calendar (1/14)",
      delayMs: 700,
    },
    {
      kind: "agent",
      speaker: "chaff",
      time: "09:49",
      text: "Maya has a conflict until 14:30. Moved it to 14:30 and sent invites.",
      delayMs: 450,
      typingMs: 850,
    },
  ],
  voice: [
    {
      kind: "human",
      speaker: "Caller",
      time: "14:02:04",
      text: "Hey, can you check my order from last Tuesday and tell me if it shipped?",
      delayMs: 300,
    },
    {
      kind: "meta",
      text: "tool_call orders/get_status · silent",
      delayMs: 850,
    },
    {
      kind: "agent",
      speaker: "chaff (audio)",
      time: "14:02:06",
      text: "Yep, order #4821 left the warehouse yesterday and is scheduled for...",
      delayMs: 450,
      typingMs: 750,
    },
    {
      kind: "meta",
      text: "barge-in · flushed outgoing audio",
      delayMs: 1100,
    },
    {
      kind: "human",
      speaker: "Caller",
      time: "14:02:09",
      text: "Actually change the drop-off note to leave it by the side gate.",
      delayMs: 900,
    },
    {
      kind: "meta",
      text: "tool_call orders/update_note",
      delayMs: 750,
    },
    {
      kind: "agent",
      speaker: "chaff (audio)",
      time: "14:02:11",
      text: "Done, updated the delivery note to side gate.",
      delayMs: 400,
      typingMs: 700,
    },
  ],
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
  participantUtteranceTurn({ name: "Dan", text: "@bot weather in Tokyo?" }),
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

const demoBody = document.getElementById("demo-body");
const replayBtn = document.getElementById("demo-replay");
const codeBlock = document.getElementById("code-block");
const copyInstallBtn = document.getElementById("copy-install");
const installStatus = document.getElementById("install-status");
const copySnippetBtn = document.getElementById("copy-snippet");

let mode = "im";
let snippet = "im";
let runId = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeTypingEl = () => {
  const row = document.createElement("div");
  row.className = "msg-row is-right";
  row.innerHTML = `
    <div class="typing-bubble">
      <span class="typing-dot" style="animation-delay: 0ms"></span>
      <span class="typing-dot" style="animation-delay: 160ms"></span>
      <span class="typing-dot" style="animation-delay: 320ms"></span>
    </div>
  `;
  return row;
};

const makeStepEl = (step) => {
  const row = document.createElement("div");
  if (step.kind === "meta") {
    row.className = "msg-row is-center";
    const pill = document.createElement("div");
    pill.className = "meta-pill";
    pill.textContent = step.text;
    row.appendChild(pill);
    return row;
  }

  const isAgent = step.kind === "agent";
  row.className = `msg-row ${isAgent ? "is-right" : "is-left"}`;
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isAgent ? "bubble-agent" : "bubble-human"}`;
  bubble.innerHTML = `
    <div class="bubble-meta">
      <span class="bubble-speaker">${step.speaker}</span>
      <span class="mono">${step.time}</span>
    </div>
    <div>${step.text}</div>
  `;
  row.appendChild(bubble);
  return row;
};

const scrollBottom = () => {
  demoBody.scrollTo({ top: demoBody.scrollHeight, behavior: "smooth" });
};

const playTrace = async (targetMode) => {
  mode = targetMode;
  const myRun = ++runId;
  const steps = scripts[targetMode];
  demoBody.innerHTML = "";

  for (const step of steps) {
    await wait(step.delayMs);
    if (runId !== myRun) return;

    if (step.typingMs) {
      const typingEl = makeTypingEl();
      demoBody.appendChild(typingEl);
      scrollBottom();
      await wait(step.typingMs);
      if (runId !== myRun) return;
      typingEl.remove();
    }

    demoBody.appendChild(makeStepEl(step));
    scrollBottom();
  }

  await wait(5500);
  if (runId === myRun) playTrace(targetMode);
};

document.querySelectorAll(".demo-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".demo-tab").forEach((other) => {
      other.classList.remove("is-active");
      other.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    playTrace(btn.dataset.mode);
  });
});

replayBtn.addEventListener("click", () => playTrace(mode));

const setSnippet = (name) => {
  snippet = name;
  codeBlock.textContent = snippets[name];
};

document.querySelectorAll(".code-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".code-tab").forEach((other) =>
      other.classList.remove("is-active")
    );
    btn.classList.add("is-active");
    setSnippet(btn.dataset.snippet);
  });
});

copyInstallBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("npm install chaff");
    installStatus.textContent = "copied";
    setTimeout(() => {
      installStatus.textContent = "copy";
    }, 1500);
  } catch {
    installStatus.textContent = "copy";
  }
});

copySnippetBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(snippets[snippet]);
    copySnippetBtn.textContent = "Copied";
    setTimeout(() => {
      copySnippetBtn.textContent = "Copy";
    }, 1500);
  } catch {
    copySnippetBtn.textContent = "Copy";
  }
});

setSnippet("im");
playTrace("im");
