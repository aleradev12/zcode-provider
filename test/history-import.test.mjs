import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = join(root, "extensions/zcode-provider.ts");
const fixture = join(root, "fixtures/fake-zcode-server.mjs");

test("imports prior Pi conversation when ZCode is first selected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-zcode-history-test-"));
  const settings = join(dir, "cli.json");
  const desktop = join(dir, "v2.json");
  const bridge = join(dir, "provider.json");
  const marker = join(dir, "create.json");
  const session = join(dir, "existing-pi-session.jsonl");
  const provider = {
    name: "Z.ai - Coding Plan",
    kind: "anthropic",
    enabled: true,
    options: {
      apiKey: "fixture-key",
      baseURL: "https://example.invalid/anthropic",
      apiKeyRequired: true,
    },
    models: {
      "GLM-5.3-Flash": {
        reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" },
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  };
  await writeFile(settings, `${JSON.stringify({
    provider: { "builtin:zai-coding-plan": provider },
    model: "builtin:zai-coding-plan/GLM-5.3-Flash",
  })}\n`);
  await writeFile(desktop, `${JSON.stringify({
    provider: { "builtin:zai-coding-plan": provider },
  })}\n`);

  const timestamp = Date.now();
  const entries = [
    {
      type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111",
      timestamp: new Date(timestamp - 3000).toISOString(), cwd: root,
    },
    {
      type: "message", id: "olduser1", parentId: null,
      timestamp: new Date(timestamp - 2000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "Remember the code word: apricot." }], timestamp: timestamp - 2000 },
    },
    {
      type: "message", id: "oldasst1", parentId: "olduser1",
      timestamp: new Date(timestamp - 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will remember that the code word is apricot." }],
        api: "openai-completions", provider: "openai", model: "fixture-model",
        usage: {
          input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop", timestamp: timestamp - 1000,
      },
    },
  ];
  await writeFile(session, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const child = spawn(
    process.env.PI_BIN || "pi",
    [
      "--mode", "rpc", "--session", session, "--no-extensions", "--extension", extension,
      "--provider", "zcode", "--model", "Z.ai - Coding Plan/GLM-5.3-Flash",
      "--thinking", "max", "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--no-themes",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ZCODE_SERVE_CMD: `${process.execPath} ${fixture}`,
        ZCODE_SETTINGS: settings,
        ZCODE_V2_CONFIG: desktop,
        ZCODE_V2_SETTING: join(dir, "setting.json"),
        ZCODE_BRIDGE_PROVIDER_CONFIG: bridge,
        ZCODE_PROTOCOL_VARIANT: "modern",
        FAKE_ZCODE_PROTOCOL_VARIANT: "modern",
        FAKE_ZCODE_CREATE_MARKER: marker,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn timed out: ${stderr}`)), 30_000);
    lines.on("line", function onLine(line) {
      const event = JSON.parse(line);
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      clearTimeout(timer);
      lines.off("line", onLine);
      resolve(event);
    });
  });

  try {
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "What was the code word?" })}\n`);
    await answer;
    const createParams = JSON.parse(await readFile(marker, "utf8"));
    assert.deepEqual(createParams.importedHistory, {
      source: "claudeCode",
      messages: [
        { role: "user", content: "Remember the code word: apricot." },
        { role: "assistant", content: "I will remember that the code word is apricot." },
      ],
    });
    assert.doesNotMatch(JSON.stringify(createParams.importedHistory), /What was the code word/);
  } finally {
    child.kill("SIGTERM");
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
});
