const demoScript = [
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
    kind: "reaction",
    emoji: "☕",
    by: "Maya",
    delayMs: 550,
  },
  {
    kind: "meta",
    text: "do_nothing · stayed silent",
    delayMs: 700,
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
  {
    kind: "reaction",
    emoji: "👍",
    by: "Dan",
    delayMs: 650,
  },
  {
    kind: "reaction",
    emoji: "🙌",
    by: "Maya",
    delayMs: 450,
  },
];

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
  participantUtteranceTurn({
    name: "Maya",
    text: "Grabbing coffee, brb",
  }),
  participantUtteranceTurn({
    name: "Dan",
    text: "@bot weather in Tokyo?",
  }),
];

const getWeather = tool({
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: z.object({ city: z.string() }),
  handler: async ({ city }) => ({
    result: JSON.stringify({
      city,
      tempC: 22,
      condition: "sunny",
    }),
  }),
});

await injectGeminiToken(process.env.GEMINI_API_KEY!)(
  injectAccessHistory(async () => history)(
    injectOutputEvent(async (event) => {
      history.push(event);
    })(async () => {
      await runAgent({
        prompt: "You are a concise group chat participant.",
        tools: [getWeather],
        maxIterations: 5,
        timezoneIANA: "Asia/Jerusalem",
      });
    }),
  ),
)();`,
  voice: `import {
  createDuplexPair,
  injectGeminiToken,
  runAgent,
} from "chaff";

const [agentSide, callerSide] = createDuplexPair();

await injectGeminiToken(process.env.GEMINI_API_KEY!)(
  async () => {
    await runAgent({
      prompt: "You are a concise voice participant.",
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
  },
)();`,
  json: `import { genJson, injectGeminiToken, z } from "chaff";

const extractContact = genJson(
  { provider: "google", tier: "flash" },
  "Extract the person's name and timezone.",
  z.object({
    name: z.string(),
    timezone: z.string(),
  }),
);

const result = await injectGeminiToken(
  process.env.GEMINI_API_KEY!,
)(
  () => extractContact("Hi, I'm Maya calling from Tel Aviv."),
)();`,
};

const demoBody = document.getElementById("demo-body");
const replayBtn = document.getElementById("demo-replay");
const codeBlock = document.getElementById("code-block");
const copyInstallBtn = document.getElementById("copy-install");
const installStatus = document.getElementById("install-status");
const copySnippetBtn = document.getElementById("copy-snippet");

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
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isAgent ? "bubble-agent" : "bubble-human"}`;
  bubble.innerHTML = `
    <div class="bubble-meta">
      <span class="bubble-speaker">${step.speaker}</span>
      <span class="mono">${step.time}</span>
    </div>
    <div>${step.text}</div>
  `;
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  return row;
};

const appendReaction = (targetWrap, emoji, by) => {
  if (!targetWrap) return;
  let bar = targetWrap.querySelector(".reaction-row");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "reaction-row";
    targetWrap.appendChild(bar);
  }
  const chip = document.createElement("span");
  chip.className = "reaction-chip";
  chip.innerHTML = `<span>${emoji}</span><span class="reaction-who">${by}</span>`;
  bar.appendChild(chip);
};

const scrollBottom = () => {
  demoBody.scrollTo({ top: demoBody.scrollHeight, behavior: "smooth" });
};

const playTrace = async () => {
  const myRun = ++runId;
  demoBody.innerHTML = "";
  let lastBubbleWrap = null;

  for (const step of demoScript) {
    await wait(step.delayMs);
    if (runId !== myRun) return;

    if (step.kind === "reaction") {
      appendReaction(lastBubbleWrap, step.emoji, step.by);
      scrollBottom();
      continue;
    }

    if (step.typingMs) {
      const typingEl = makeTypingEl();
      demoBody.appendChild(typingEl);
      scrollBottom();
      await wait(step.typingMs);
      if (runId !== myRun) return;
      typingEl.remove();
    }

    const row = makeStepEl(step);
    demoBody.appendChild(row);
    const wrap = row.querySelector(".bubble-wrap");
    if (wrap) lastBubbleWrap = wrap;
    scrollBottom();
  }

  await wait(5500);
  if (runId === myRun) playTrace();
};

replayBtn.addEventListener("click", () => playTrace());

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const highlightTs = (source) => {
  const tokenRe =
    /(\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|const|let|async|await|return|export|type|new)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z_$][\w$]*(?=\s*:))/g;
  let out = "";
  let lastIndex = 0;
  for (const match of source.matchAll(tokenRe)) {
    const idx = match.index ?? 0;
    out += escapeHtml(source.slice(lastIndex, idx));
    const tok = match[0];
    const escaped = escapeHtml(tok);
    if (tok.startsWith("//")) {
      out += `<span class="tok-cmt">${escaped}</span>`;
    } else if (tok.startsWith('"') || tok.startsWith("'")) {
      out += `<span class="tok-str">${escaped}</span>`;
    } else if (/^\d/.test(tok)) {
      out += `<span class="tok-num">${escaped}</span>`;
    } else if (
      /^(import|from|const|let|async|await|return|export|type|new)$/.test(tok)
    ) {
      out += `<span class="tok-kw">${escaped}</span>`;
    } else if (source[idx + tok.length] === "(") {
      out += `<span class="tok-fn">${escaped}</span>`;
    } else {
      out += `<span class="tok-key">${escaped}</span>`;
    }
    lastIndex = idx + tok.length;
  }
  out += escapeHtml(source.slice(lastIndex));
  return out;
};

const setSnippet = (name) => {
  snippet = name;
  codeBlock.innerHTML = highlightTs(snippets[name]);
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
playTrace();
