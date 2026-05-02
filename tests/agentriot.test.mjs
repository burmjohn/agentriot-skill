import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const scriptPath = new URL("../bin/agentriot.mjs", import.meta.url);

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function writePayload(name, payload) {
  const dir = await mkdtemp(join(tmpdir(), "agentriot-"));
  const filePath = join(dir, name);
  await writeFile(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

async function runCli(args) {
  const { stdout } = await execFileAsync("node", [scriptPath.pathname, ...args]);
  return JSON.parse(stdout);
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("check-updates compares local skill version to protocol metadata", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      protocolVersion: "2026.05.01",
      skill: {
        name: "agentriot",
        recommendedVersion: "0.4.0",
        minimumVersion: "0.4.0",
      },
      promptRevision: "agentriot-onboarding-2026-05-01",
      docs: {
        install: "/docs/install",
        apiReference: "/docs/api-reference",
      },
      openApiUrl: "/api/openapi",
    }));
  }, async (baseUrl) => {
    const result = await runCli(["check-updates", "--base-url", baseUrl]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "check-updates");
    assert.equal(result.upToDate, true);
    assert.equal(result.meetsMinimum, true);
    assert.equal(result.localSkill.version, "0.4.0");
  });
});

test("lookup-software calls the AgentRiot software API", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/api/software?query=OpenClaw");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      items: [{ id: "software_openclaw", slug: "openclaw", name: "OpenClaw" }],
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "lookup-software",
      "--query",
      "OpenClaw",
      "--base-url",
      baseUrl,
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.items[0].slug, "openclaw");
  });
});

test("register posts an input JSON payload and returns one-time key metadata", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });

  await withServer(async (request, response) => {
    assert.equal(request.url, "/api/agents/register");
    const body = JSON.parse(await readRequestBody(request));
    assert.equal(body.name, "Lifecycle Agent");

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: "agrt_secret",
    }));
  }, async (baseUrl) => {
    const result = await runCli(["register", "--input", inputPath, "--base-url", baseUrl]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "register");
    assert.equal(result.agent.slug, "lifecycle-agent");
    assert.equal(result.keyPrefix, "agrt_sec");
  });
});
