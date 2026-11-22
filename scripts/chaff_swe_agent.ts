import {
  type AgentSpec,
  type HistoryEvent,
  injectAccessHistory,
  injectGeminiModelVersions,
  injectGeminiToken,
  injectOutputEvent,
  injectShouldAbort,
  injectTokenUsage,
  participantUtteranceTurn,
  runAgent,
  tool,
  type ToolOutputScratchPad,
  z,
} from "../mod.ts";
import { injectGeminiModelCallTimeoutMs } from "../src/geminiAgent.ts";
import { ThinkingLevel } from "@google/genai";
import { parseArgs } from "@std/cli/parse-args";
import { encodeBase64 } from "@std/encoding/base64";
import { extname, resolve } from "@std/path";

const mediaMimeByExt: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};
const maxInlineMediaBytes = 15 * 1024 * 1024;

type UsageStats = {
  promptTokens: number;
  cachedTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  totalCalls: number;
  byModel: Record<
    string,
    {
      calls: number;
      promptTokens: number;
      cachedTokens: number;
      candidatesTokens: number;
      thoughtsTokens: number;
      totalTokens: number;
    }
  >;
};

const createScratchPad = (): ToolOutputScratchPad => {
  const store = new Map<string, string>();
  return {
    set: (id, content) => {
      store.set(id, content);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(store.get(id)),
  };
};

const createSweTools = (
  workdir: string,
  onFinish: (message: string) => void,
) => {
  const bashTool = tool({
    name: "bash",
    description:
      "Run a bash command in the workspace directory. Returns stdout, stderr, and exit code.",
    parameters: z.object({
      command: z.string().describe("Bash command to execute"),
      timeout_seconds: z.number().optional().describe(
        "Timeout in seconds (default: 120)",
      ),
    }),
    handler: async ({ command, timeout_seconds = 120 }) => {
      try {
        const p = new Deno.Command("bash", {
          args: ["-c", command],
          cwd: workdir,
          stdout: "piped",
          stderr: "piped",
        });
        const child = p.spawn();
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timerId = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already exited
            }
            reject(new Error(`Command timed out after ${timeout_seconds}s`));
          }, timeout_seconds * 1000);
        });
        const result = await Promise.race([child.output(), timeoutPromise]);
        if (timerId !== undefined) clearTimeout(timerId);
        const stdoutStr = new TextDecoder().decode(result.stdout);
        const stderrStr = new TextDecoder().decode(result.stderr);
        const combined = stderrStr
          ? (stdoutStr ? `${stdoutStr}\nSTDERR:\n${stderrStr}` : stderrStr)
          : stdoutStr;
        return JSON.stringify({
          exit_code: result.code,
          output: combined || "(no output)",
        });
      } catch (err) {
        return JSON.stringify({
          exit_code: -1,
          output: `Command failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
  });

  const readFileTool = tool({
    name: "read_file",
    description:
      "Read file contents with line numbers (or inspect images/PDFs natively). Use offset and limit to read sections of large text files.",
    parameters: z.object({
      file_path: z.string().describe(
        "File path relative to workspace or absolute",
      ),
      offset: z.number().int().optional().describe(
        "1-indexed line number to start reading from",
      ),
      limit: z.number().int().optional().describe(
        "Number of lines to read (default: 2000)",
      ),
    }),
    handler: async ({ file_path, offset = 1, limit = 2000 }) => {
      try {
        const fullPath = resolve(workdir, file_path);
        const mimeType = mediaMimeByExt[extname(fullPath).toLowerCase()];
        if (mimeType) {
          const bytes = await Deno.readFile(fullPath);
          if (bytes.byteLength > maxInlineMediaBytes) {
            return `Error reading ${file_path}: file size ${bytes.byteLength} bytes exceeds ${maxInlineMediaBytes}-byte inline limit.`;
          }
          return {
            result:
              `Attached ${mimeType} file: ${file_path} (${bytes.byteLength} bytes).`,
            attachments: [
              {
                kind: "inline" as const,
                mimeType,
                dataBase64: encodeBase64(bytes),
                caption: file_path,
              },
            ],
          };
        }
        const content = await Deno.readTextFile(fullPath);
        const lines = content.split("\n");
        const start = Math.max(0, offset - 1);
        const end = Math.min(lines.length, start + limit);
        const numbered = lines.slice(start, end).map((line, idx) =>
          `${start + idx + 1}: ${line}`
        ).join("\n");
        return `File: ${file_path} (lines ${
          start + 1
        }-${end} of ${lines.length})\n${numbered}`;
      } catch (err) {
        return `Error reading ${file_path}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

  const writeFileTool = tool({
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing file.",
    parameters: z.object({
      file_path: z.string().describe(
        "File path relative to workspace or absolute",
      ),
      content: z.string().describe("Content to write into the file"),
    }),
    handler: async ({ file_path, content }) => {
      try {
        const fullPath = resolve(workdir, file_path);
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir) await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(fullPath, content);
        return `Successfully wrote ${content.length} characters to ${file_path}`;
      } catch (err) {
        return `Error writing to ${file_path}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

  const editFileTool = tool({
    name: "edit_file",
    description:
      "Replace an exact string in a file with new text. old_string must appear exactly once.",
    parameters: z.object({
      file_path: z.string().describe(
        "File path relative to workspace or absolute",
      ),
      old_string: z.string().describe(
        "Exact string to replace (must be unique)",
      ),
      new_string: z.string().describe("Replacement text"),
    }),
    handler: async ({ file_path, old_string, new_string }) => {
      try {
        const fullPath = resolve(workdir, file_path);
        const content = await Deno.readTextFile(fullPath);
        const count = content.split(old_string).length - 1;
        if (count === 0) {
          return `Error: old_string not found in ${file_path}.`;
        }
        if (count > 1) {
          return `Error: old_string found ${count} times in ${file_path}. Provide more surrounding context.`;
        }
        await Deno.writeTextFile(
          fullPath,
          content.replace(old_string, new_string),
        );
        return `Successfully edited ${file_path}`;
      } catch (err) {
        return `Error editing ${file_path}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

  const finishTool = tool({
    name: "finish",
    description:
      "Call this tool when you have completely solved and verified the task.",
    parameters: z.object({
      message: z.string().describe("Summary of changes and verification"),
    }),
    handler: ({ message }) => {
      onFinish(message);
      return Promise.resolve("Task marked as finished.");
    },
  });

  return [bashTool, readFileTool, writeFileTool, editFileTool, finishTool];
};

const SWE_SYSTEM_PROMPT =
  `You are an autonomous software engineer solving technical tasks in a Linux container.
Explore the workspace, inspect code and existing tests, implement the fix cleanly, verify thoroughly using bash, and call finish when completely done and verified.`;

const parseThinking = (raw?: string): ThinkingLevel | undefined => {
  if (!raw || raw === "auto") return undefined;
  const upper = raw.toUpperCase();
  if (upper === "HIGH") return ThinkingLevel.HIGH;
  if (upper === "MEDIUM") return ThinkingLevel.MEDIUM;
  if (upper === "LOW") return ThinkingLevel.LOW;
  if (upper === "MINIMAL") return ThinkingLevel.MINIMAL;
  return undefined;
};

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["task", "workdir", "output", "model", "thinking"],
    alias: { t: "task", w: "workdir", o: "output", m: "model" },
  });

  const task = args.task || String(args._[0] ?? "");
  if (!task) {
    console.error(
      'Usage: chaff-agent --task "<instruction>" [--workdir <dir>] [--output <path>] [--model <model>]',
    );
    Deno.exit(1);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.error("GEMINI_API_KEY environment variable required");
    Deno.exit(1);
  }

  const workdir = args.workdir ? resolve(args.workdir) : Deno.cwd();
  const model = (args.model || "gemini-4-hydrogen").replace(/^google\//, "");
  const thinkingLevel = parseThinking(args.thinking ?? "high");

  const usage: UsageStats = {
    promptTokens: 0,
    cachedTokens: 0,
    candidatesTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    totalCalls: 0,
    byModel: {},
  };

  let isDone = false;
  let finishMessage = "";
  const history: HistoryEvent[] = [
    participantUtteranceTurn({ name: "user", text: task }),
  ];

  const tools = createSweTools(workdir, (msg) => {
    isDone = true;
    finishMessage = msg;
  });

  const spec: AgentSpec = {
    provider: "google",
    prompt: SWE_SYSTEM_PROMPT,
    tools,
    maxIterations: 120,
    hardMaxIterations: 120,
    timezoneIANA: "UTC",
    thinkingLevel,
    toolOutputScratchPad: createScratchPad(),
    urlGroundingExemptToolNames: [
      "bash",
      "read_file",
      "write_file",
      "edit_file",
    ],
    disableStreaming: false,
  };

  const startedAt = Date.now();
  let runError: string | undefined;

  try {
    await injectGeminiToken(apiKey)(
      injectGeminiModelCallTimeoutMs(() => 300_000)(
        injectGeminiModelVersions(() => ({
          pro: model,
          flash: model,
          lite: model,
          fallback: model,
        }))(
          injectTokenUsage((u, m) => {
            const prompt = u.promptTokenCount ?? 0;
            const cached = u.cachedContentTokenCount ?? 0;
            const cand = u.candidatesTokenCount ?? 0;
            const thoughts = u.thoughtsTokenCount ?? 0;
            const total = u.totalTokenCount ?? (prompt + cand + thoughts);
            usage.totalCalls += 1;
            usage.promptTokens += prompt;
            usage.cachedTokens += cached;
            usage.candidatesTokens += cand;
            usage.thoughtsTokens += thoughts;
            usage.totalTokens += total;
            const bucket = usage.byModel[m] ?? {
              calls: 0,
              promptTokens: 0,
              cachedTokens: 0,
              candidatesTokens: 0,
              thoughtsTokens: 0,
              totalTokens: 0,
            };
            bucket.calls += 1;
            bucket.promptTokens += prompt;
            bucket.cachedTokens += cached;
            bucket.candidatesTokens += cand;
            bucket.thoughtsTokens += thoughts;
            bucket.totalTokens += total;
            usage.byModel[m] = bucket;
          })(
            injectAccessHistory(() => Promise.resolve(history))(
              injectOutputEvent((event) => {
                if (event.type === "tool_call") {
                  console.log(`[chaff] tool_call ${event.name}`);
                } else if (
                  event.type === "own_utterance" && event.text?.trim()
                ) {
                  console.log(`[chaff] utterance: ${event.text.slice(0, 200)}`);
                }
                history.push(event);
                return Promise.resolve();
              })(
                injectShouldAbort(() => Promise.resolve(isDone))(
                  () => runAgent(spec),
                ),
              ),
            ),
          ),
        ),
      ),
    )();
  } catch (err) {
    runError = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[chaff] error:", runError);
  }

  const durationSec = (Date.now() - startedAt) / 1000;
  const output = {
    model,
    thinkingLevel: thinkingLevel ?? "auto",
    durationSec,
    isDone,
    finishMessage,
    runError,
    usage,
    historyLength: history.length,
    toolCalls: history.filter((e) => e.type === "tool_call").length,
  };

  console.log("[chaff] summary:", JSON.stringify(output, null, 2));
  if (args.output) {
    await Deno.writeTextFile(args.output, JSON.stringify(output, null, 2));
  }
  Deno.exit(runError ? 1 : 0);
}
