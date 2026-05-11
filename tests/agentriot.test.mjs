import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
        recommendedVersion: "0.6.0",
        minimumVersion: "0.6.0",
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
    assert.equal(result.localSkill.version, "0.6.0");
  });
});

test("mcp-config emits remote hosted MCP config without echoing raw keys", async () => {
  const result = await runCli([
    "mcp-config",
    "--api-key",
    "agrt_secret_key",
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "mcp-config");
  assert.equal(result.endpoint, "https://agentriot.com/api/mcp");
  assert.equal(result.config.mcpServers.agentriot.type, "http");
  assert.equal(result.config.mcpServers.agentriot.url, "https://agentriot.com/api/mcp");
  assert.equal(
    result.config.mcpServers.agentriot.headers.Authorization,
    "Bearer ${AGENTRIOT_API_KEY}",
  );
  assert.equal(JSON.stringify(result).includes("agrt_secret_key"), false);
});

test("CLI defaults to AgentRiot production for static commands", async () => {
  const result = await runCli(["profile", "--slug", "my-research-agent"]);

  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, "https://agentriot.com/agents/my-research-agent");
});

test("write commands do not contain a production confirmation guard", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.equal(source.includes("confirm-production"), false);
  assert.equal(source.includes("assertProductionWriteAllowed"), false);
  assert.equal(source.includes("isProductionBaseUrl"), false);
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

test("public docs avoid maintainer-only command details and exclusion lists", async () => {
  const root = new URL("../", import.meta.url);
  const docs = [
    await readFile(new URL("README.md", root), "utf8"),
    await readFile(new URL("SKILL.md", root), "utf8"),
  ].join("\n");
  const forbidden = [
    "localhost",
    "--base-url",
    "confirm-production",
    "staging",
    "software listing writes",
    "admin content",
    "moderation controls",
    "database tooling",
    "deployment tooling",
    "destructive deletes",
    "cross-agent",
  ];

  for (const phrase of forbidden) {
    assert.equal(docs.includes(phrase), false, `unexpected public docs phrase: ${phrase}`);
  }
});

test("skill frontmatter is GitHub-compatible YAML", async () => {
  const skill = await readFile(new URL("SKILL.md", new URL("../", import.meta.url)), "utf8");
  const frontmatter = skill.match(/^---\n(?<yaml>[\s\S]*?)\n---/u)?.groups?.yaml;

  assert.ok(frontmatter);
  assert.match(frontmatter, /^name: agentriot$/m);
  assert.match(frontmatter, /^description: "/m);
});

test("public docs link to canonical AgentRiot references", async () => {
  const root = new URL("../", import.meta.url);
  const docs = [
    await readFile(new URL("README.md", root), "utf8"),
    await readFile(new URL("SKILL.md", root), "utf8"),
  ].join("\n");
  const requiredLinks = [
    "https://agentriot.com/docs/api-reference",
    "https://agentriot.com/api/openapi",
    "https://agentriot.com/docs/install",
    "https://agentriot.com/docs/claim-agent",
    "https://agentriot.com/agent-instructions",
  ];

  for (const link of requiredLinks) {
    assert.ok(docs.includes(link), `missing canonical docs link: ${link}`);
  }
});

test("public npm commands are clearly framed as post-publish", async () => {
  const root = new URL("../", import.meta.url);
  const docs = {
    README: await readFile(new URL("README.md", root), "utf8"),
    SKILL: await readFile(new URL("SKILL.md", root), "utf8"),
  };
  const npmCommandPattern = /(npx agentriot-skill|npm install -g agentriot-skill)/u;

  for (const [name, text] of Object.entries(docs)) {
    if (!npmCommandPattern.test(text)) continue;

    assert.match(
      text,
      /(After npm publishing|post-publish|published to npm)/u,
      `${name} contains npm commands without post-publish framing`,
    );
  }
});
