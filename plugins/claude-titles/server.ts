// bb-plugin-claude-titles — names bb threads from their whole conversation
// with the local Claude Code CLI (`claude -p`), and writes commit messages.
//
// bb's own title request only sees the first prompt clamped to 80 characters,
// so a handoff brief or a long question reaches the model with nothing to
// title ("I need the actual task", "Integrar modelo gratuito en"). The plugin
// therefore titles every new thread itself, once:
//
// - bb's request for a thread that was just created is declined, which leaves
//   the thread untitled for a moment;
// - `thread.created`/`thread.active` title it from the full first prompt.
//
// After that the title never changes on its own. Saving an empty name
// (app.tsx → `retitle` RPC) or `bb claude-titles retitle` titles the thread
// again from its whole conversation (the user's prompts plus the agent's
// latest reply).
//
// bb still calls the service with no thread for `bb settings ai-services test`
// and for commit messages; those get one fast `claude -p` call each.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SYSTEM_PROMPT =
  "Follow the user's instructions exactly. Reply with only the requested text.";
const STDOUT_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 8 * 1024;

// Conversation titles run outside bb's 5 s task limit.
const CONVERSATION_TITLE_TIMEOUT_MS = 20_000;
const TURN_REQUEST_LIMIT = 100;
const FIRST_PROMPT_MAX_CHARS = 2500;
const LATER_PROMPT_MAX_CHARS = 300;
const LATER_PROMPT_COUNT = 8;
const REPLY_MAX_CHARS = 800;
// bb's sidebar row fits about 37 characters next to the status spinner, fewer
// when the sidebar is narrow. The prompt asks for 30; longer replies are cut here.
const TITLE_MAX_CHARS = 34;
// bb skips titling prompts under 5 words; so does the plugin.
const MIN_TITLE_WORDS = 5;
// The first turn request lands a few ms after the thread row; poll briefly.
const FIRST_PROMPT_ATTEMPTS = 10;
const FIRST_PROMPT_DELAY_MS = 500;
// A bb title request within this long of a thread's creation is for that thread.
const NEW_THREAD_WINDOW_MS = 60_000;
const THREAD_SCAN_LIMIT = 50;
const RETITLE_ALL_LIMIT = 200;

const BB_TITLE_PROMPT_START = "You create concise titles for coding tasks.";
const BB_LENGTH_RULE = /Keep it under about 40 characters;[^.]*\./u;
const LENGTH_RULE =
  "Use 2 to 5 words and at most 30 characters, as a complete phrase that never ends on a preposition, article or conjunction.";

// Replies that talk to the user instead of titling ("I need the actual task",
// "Could you share…", "¿Qué tarea…?") must never become a title.
const CONVERSATIONAL_REPLY =
  /^(?:i|i'm|i am|i need|please|sorry|could you|can you|necesito|por favor|lo siento|no puedo)\b|^¿|\?$/iu;

// Words a cut title must not end on ("Integrar modelo gratuito en").
const DANGLING_WORDS = new Set(
  (
    "a al and an at by con de del el en for from in into la las los of on or " +
    "para por sin the to with y o u e"
  ).split(" "),
);

function isTitlePrompt(prompt: string): boolean {
  return prompt.startsWith(BB_TITLE_PROMPT_START);
}

function isConversational(title: string): boolean {
  return CONVERSATIONAL_REPLY.test(title);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const countWords = (text: string) => text.split(/\s+/u).filter(Boolean).length;

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

export const rpcContract = defineRpcContract({
  retitle: {
    input: z.object({ threadId: z.string().regex(/^thr_[A-Za-z0-9]+$/) }).strict(),
    output: z.object({ title: z.string() }),
  },
});

interface Conversation {
  prompts: string[];
  reply: string | null;
}

function buildConversationTitlePrompt(conversation: Conversation): string {
  const [first, ...later] = conversation.prompts;
  const lines = [
    "You name conversations between a developer and a coding agent. The name is shown in a sidebar list of threads.",
    "Read the conversation below and reply with only its name.",
    "",
    "Rules:",
    "- Name the concrete subject and what is being done with it, so the developer can tell this thread apart from the others at a glance.",
    "- Prefer specific things (product, feature, ticket or PR ID, file, person) over generic words such as task, check, functionality, issue, help, question.",
    "- If the conversation moved on from the first request, name what it is about now.",
    "- Ignore boilerplate: handoff preambles, greetings, instructions about how the assistant should behave, tool and skill names.",
    `- ${LENGTH_RULE}`,
    "- Sentence case, in the language the developer writes in, no quotes, no trailing punctuation, no explanation.",
    "",
    "Good names: Fix Stripe webhook retries · TDT-RNK-4120 slow search query · Migrar login a OAuth · Revisión del PR #812 de pagos",
    "Bad names: Help with task · Funcionamiento ordenamiento · Integrar modelo gratuito en · Continue previous session",
  ];
  lines.push("", "Conversation:", "First user message:", (first ?? "").slice(0, FIRST_PROMPT_MAX_CHARS));
  const recent = later.slice(-LATER_PROMPT_COUNT);
  if (recent.length > 0) {
    lines.push("", "Later user messages:");
    for (const prompt of recent) lines.push(`- ${oneLine(prompt).slice(0, LATER_PROMPT_MAX_CHARS)}`);
  }
  if (conversation.reply) {
    lines.push("", "Latest agent reply (excerpt):", conversation.reply.slice(0, REPLY_MAX_CHARS));
  }
  return lines.join("\n");
}

function promptText(input: ReadonlyArray<{ type: string; text?: string }>): string {
  return input
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim();
}

/** Cuts at a word boundary without leaving "… en" or "… for" at the end. */
function fitTitle(title: string): string {
  if (title.length <= TITLE_MAX_CHARS) return title;
  const words = title.slice(0, TITLE_MAX_CHARS + 1).split(" ");
  if (words.length > 1) words.pop();
  while (words.length > 1 && DANGLING_WORDS.has(words[words.length - 1]!.toLowerCase())) {
    words.pop();
  }
  return words.join(" ").replace(/[\s:;,\-–—]+$/u, "");
}

function sanitizeTitle(reply: string): string {
  return fitTitle(cleanTitle(reply));
}

/** Strips markdown, labels, quotes and trailing punctuation; does not cut. */
function cleanTitle(reply: string): string {
  const line = reply.split("\n").find((l) => l.trim()) ?? "";
  return line
    .trim()
    // Markdown heading, list or emphasis markers the model sometimes adds.
    .replace(/^(?:[#>*_\-]+\s*)+/u, "")
    .replace(/[*_]+$/u, "")
    .replace(/^((?:title|name|nombre|título):\s*)/iu, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "")
    .replace(/[.。!:;,]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildShortenTitlePrompt(title: string): string {
  return [
    `This thread name is too long for a sidebar: ${title}`,
    "Reply with only a shorter name for the same subject.",
    `${LENGTH_RULE} Keep the most specific words (product, feature, ticket or PR ID); drop filler.`,
    "Write it in the same language as the name above (do not translate it), sentence case, no quotes, no trailing punctuation, no explanation.",
  ].join("\n");
}

// The bb daemon rarely inherits the shell PATH, so check the usual install
// locations after PATH.
const FALLBACK_PATHS = [
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".claude", "local", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findClaude(configuredPath: string): string | null {
  const configured = configuredPath.trim();
  if (configured) return isExecutable(configured) ? configured : null;
  const fromPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "claude"));
  return [...fromPath, ...FALLBACK_PATHS].find(isExecutable) ?? null;
}

/** Appends to a buffer list until `max` bytes; returns the new total. */
function appendBounded(chunks: Buffer[], total: number, chunk: Buffer, max: number): number {
  if (total >= max) return total;
  const slice = chunk.subarray(0, max - total);
  chunks.push(slice);
  return total + slice.length;
}

function runClaude(
  binary: string,
  model: string,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const args = [
      "-p",
      "--model", model,
      "--output-format", "text",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--no-chrome",
      "--system-prompt", SYSTEM_PROMPT,
    ];
    const child = spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Keep the binary's own directory on PATH for anything it spawns.
        PATH: [dirname(binary), process.env.PATH].filter(Boolean).join(delimiter),
        MAX_THINKING_TOKENS: "0",
      },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal.reason ?? new Error("Aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendBounded(stdout, stdoutBytes, chunk, STDOUT_MAX_BYTES);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendBounded(stderr, stderrBytes, chunk, STDERR_MAX_BYTES);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, closeSignal) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8").trim());
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        const status = code === null ? `signal ${closeSignal}` : `code ${code}`;
        reject(new Error(`claude exited with ${status}${detail ? `: ${detail}` : ""}`));
      });
    });

    // EPIPE when the child dies before reading stdin surfaces through `close`.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "select",
      label: "Model for bb's quick requests (5 s limit)",
      options: ["haiku", "sonnet"],
      default: "haiku",
    },
    conversationModel: {
      type: "select",
      label: "Model for titles from the whole conversation",
      options: ["sonnet", "haiku"],
      default: "sonnet",
    },
    claudePath: {
      type: "string",
      label: "Path to the claude binary (empty = detect automatically)",
      default: "",
    },
  });

  // An empty working directory, so claude loads no CLAUDE.md or project files.
  const workDir = await mkdtemp(join(tmpdir(), "bb-claude-titles-"));
  bb.onDispose(() => rm(workDir, { recursive: true, force: true }));

  async function complete(
    prompt: string,
    signal: AbortSignal,
    model?: string,
  ): Promise<string> {
    const current = await settings.get();
    const binary = findClaude(current.claudePath);
    if (!binary) throw new Error("claude CLI not found");
    return runClaude(binary, model ?? current.model, prompt, workDir, signal);
  }

  // bb asks for a title right after it creates a thread; the listeners below
  // title that thread from its whole prompt instead.
  async function hasNewUntitledThread(): Promise<boolean> {
    const threads = await bb.sdk.threads.list({ includeHidden: true, limit: THREAD_SCAN_LIMIT });
    const now = Date.now();
    return threads.some((thread) => !thread.title && now - thread.createdAt < NEW_THREAD_WINDOW_MS);
  }

  bb.experimental_aiServices.register({
    id: "claude-code",
    displayName: "Claude Code",
    complete: async (prompt, { signal }) => {
      if (!isTitlePrompt(prompt)) return complete(prompt, signal);
      if (await hasNewUntitledThread()) {
        throw new Error("the claude-titles plugin titles new threads from their whole prompt");
      }
      const title = sanitizeTitle(
        await complete(prompt.replace(BB_LENGTH_RULE, LENGTH_RULE), signal),
      );
      if (isConversational(title)) throw new Error(`claude did not reply with a title: ${title}`);
      return title;
    },
    status: async () => {
      const { claudePath } = await settings.get();
      if (findClaude(claudePath)) return { ready: true };
      return {
        ready: false,
        message: claudePath.trim()
          ? `claude not found or not executable at ${claudePath.trim()}`
          : "claude CLI not found. Install Claude Code or set its path in the plugin settings",
      };
    },
  });

  // Prompt history leaves out the prompt that created the thread, so read the
  // turn requests from the event log, oldest first.
  // bb serves at most 100 events per read: take the first request plus the
  // latest ones, which is all the title prompt uses.
  async function userPrompts(threadId: string): Promise<string[]> {
    const read = (order: "asc" | "desc", limit: number) =>
      bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order,
        limit: String(limit),
      });
    const [first, latest] = await Promise.all([read("asc", 1), read("desc", TURN_REQUEST_LIMIT)]);
    const seen = new Set<string>();
    const requests = [...first, ...latest.reverse()].filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
    return requests
      .flatMap((event) =>
        event.type === "client/turn/requested" && event.data.initiator === "user"
          ? [promptText(event.data.input)]
          : [],
      )
      .filter((text) => text.length > 0);
  }

  async function latestReply(threadId: string): Promise<string | null> {
    try {
      return (await bb.sdk.threads.output({ threadId })).output;
    } catch {
      return null;
    }
  }

  async function generateTitle(conversation: Conversation): Promise<string> {
    const { conversationModel } = await settings.get();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("claude took too long to answer")),
      CONVERSATION_TITLE_TIMEOUT_MS,
    );
    let title: string;
    try {
      title = cleanTitle(
        await complete(buildConversationTitlePrompt(conversation), controller.signal, conversationModel),
      );
      // Models miscount characters; ask once for a shorter name before cutting.
      if (title.length > TITLE_MAX_CHARS && !isConversational(title)) {
        try {
          const shorter = cleanTitle(
            await complete(buildShortenTitlePrompt(title), controller.signal, conversationModel),
          );
          if (shorter && !isConversational(shorter)) title = shorter;
        } catch (error) {
          bb.log.warn(
            `could not shorten "${title}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      clearTimeout(timer);
    }
    title = fitTitle(title);
    if (!title) throw new Error("claude returned an empty title");
    if (isConversational(title)) throw new Error(`claude did not reply with a title: ${title}`);
    return title;
  }

  const inFlight = new Set<string>();

  /**
   * Titles a thread from its conversation. `force` (empty-name rename, CLI)
   * replaces any title; otherwise only an untitled thread is titled.
   */
  async function titleThread(
    threadId: string,
    options: { force?: boolean; waitForPrompt?: boolean } = {},
  ): Promise<string | null> {
    if (inFlight.has(threadId)) {
      if (options.force) throw new Error("A title is already being generated for this thread");
      return null;
    }
    inFlight.add(threadId);
    try {
      let prompts = await userPrompts(threadId);
      for (let i = 1; options.waitForPrompt && prompts.length === 0 && i < FIRST_PROMPT_ATTEMPTS; i++) {
        await sleep(FIRST_PROMPT_DELAY_MS);
        prompts = await userPrompts(threadId);
      }
      if (prompts.length === 0) {
        if (options.force) throw new Error("This thread has no prompt to title yet");
        return null;
      }

      if (!options.force) {
        if ((await bb.sdk.threads.get({ threadId })).title) return null;
        if (countWords(prompts.join(" ")) < MIN_TITLE_WORDS) return null;
      }

      const title = await generateTitle({ prompts, reply: await latestReply(threadId) });

      // The user may have named the thread while claude was answering.
      const latest = await bb.sdk.threads.get({ threadId });
      if (!options.force && latest.title) return null;
      if (latest.title !== title) {
        await bb.sdk.threads.update({ threadId, title });
        bb.log.info(`titled ${threadId}: ${title}`);
      }
      return title;
    } finally {
      inFlight.delete(threadId);
    }
  }

  function inBackground(threadId: string, run: () => Promise<unknown>): void {
    run().catch((error: unknown) => {
      bb.log.warn(
        `could not title ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  bb.events.on("thread.created", ({ thread }) => {
    if (!thread.title) inBackground(thread.id, () => titleThread(thread.id, { waitForPrompt: true }));
  });
  bb.events.on("thread.active", ({ thread }) => {
    if (!thread.title) inBackground(thread.id, () => titleThread(thread.id, { waitForPrompt: true }));
  });

  // Called by app.tsx when a thread rename is submitted empty.
  bb.rpc.register(rpcContract, {
    async retitle({ threadId }) {
      const title = await titleThread(threadId, { force: true });
      if (!title) throw new Error("claude returned an empty title");
      return { title };
    },
  });

  bb.cli.register({
    name: "claude-titles",
    summary: "Name bb threads from their whole conversation with Claude",
    commands: [
      {
        name: "retitle",
        summary: "Title threads again from their whole conversation",
        usage: "bb claude-titles retitle <thread-id>... | --all",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      if (command !== "retitle" || rest.length === 0) {
        return {
          exitCode: command === "--help" || command === "-h" ? 0 : 1,
          stdout: "Usage: bb claude-titles retitle <thread-id>... | --all\n",
        };
      }
      const ids = rest.includes("--all")
        ? (await bb.sdk.threads.list({ archived: false, limit: RETITLE_ALL_LIMIT })).map((t) => t.id)
        : rest;
      const lines: string[] = [];
      let failed = 0;
      for (const threadId of ids) {
        try {
          const before = (await bb.sdk.threads.get({ threadId })).title ?? "(untitled)";
          const title = await titleThread(threadId, { force: true });
          lines.push(`${threadId}  ${before}  →  ${title}`);
        } catch (error) {
          failed++;
          lines.push(`${threadId}  failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { exitCode: failed > 0 ? 1 : 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  bb.log.info(`loaded; claude runs in ${workDir}`);
}
