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

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runCli(args) {
  const { stdout } = await execFileAsync("node", [scriptPath.pathname, ...args]);
  return JSON.parse(stdout);
}

async function runCliFailure(args) {
  try {
    await execFileAsync("node", [scriptPath.pathname, ...args]);
  } catch (error) {
    return {
      code: error.code,
      stderr: error.stderr.trim(),
      stdout: error.stdout.trim(),
    };
  }

  assert.fail("CLI command unexpectedly succeeded");
}

function protocolResponse(overrides = {}) {
  return {
    protocolVersion: "2026.05.12",
    skill: {
      name: "agentriot",
      recommendedVersion: "0.7.0",
      minimumVersion: "0.7.0",
    },
    contract: {
      version: "2026.05.12",
      minimumSupportedVersion: "2026.05.12",
      limits: {},
    },
    ...overrides,
  };
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
        recommendedVersion: "0.7.0",
        minimumVersion: "0.7.0",
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
    assert.equal(result.localSkill.version, "0.7.0");
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

test("register generates and persists a stable installation identity with returned credentials", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  let seenBody = null;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/register");
    const body = JSON.parse(await readRequestBody(request));
    seenBody = body;

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "created",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: "agrt_secret",
    }));
  }, async (baseUrl) => {
    const result = await runCli(["register", "--input", inputPath, "--base-url", baseUrl]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "register");
    assert.equal(seenBody.name, "Lifecycle Agent");
    assert.equal(typeof seenBody.installationId, "string");
    assert.ok(seenBody.installationId.length > 20);
    assert.equal(result.agent.slug, "lifecycle-agent");
    assert.equal(result.keyPrefix, "agrt_sec");
    assert.equal(result.registrationStatus, "created");

    const state = await readJsonFile(statePath);
    assert.equal(state.installationId, result.installationId);
    assert.equal(state.agentSlug, "lifecycle-agent");
    assert.equal(state.apiKey, "agrt_secret");
  });
});

test("register reuses the persisted installation identity on repeat registration", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  await writeFile(statePath, JSON.stringify({
    installationId: "install_existing_1234567890",
    agentSlug: "lifecycle-agent",
    apiKey: "agrt_existing",
  }), "utf8");
  let seenBody = null;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/register");
    const body = JSON.parse(await readRequestBody(request));
    seenBody = body;

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "existing",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: null,
    }));
  }, async (baseUrl) => {
    const result = await runCli(["register", "--input", inputPath, "--base-url", baseUrl]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "register");
    assert.equal(seenBody.installationId, "install_existing_1234567890");
    assert.equal(result.registrationStatus, "existing");
    assert.equal(result.apiKeyReturned, false);
    assert.equal(result.storedApiKeyAvailable, true);

    const state = await readJsonFile(statePath);
    assert.equal(state.installationId, "install_existing_1234567890");
    assert.equal(state.apiKey, "agrt_existing");
  });
});

test("validate accepts a 10000 character prompt and rejects a 10001 character prompt locally", async () => {
  const validPath = await writePayload("prompt.json", {
    title: "Research brief prompt",
    description: "Summarizes public research notes into a reusable brief.",
    prompt: "p".repeat(10000),
    expectedOutput: "A concise brief.",
    tags: ["research", "brief"],
  });
  const invalidPath = await writePayload("prompt.json", {
    title: "Research brief prompt",
    description: "Summarizes public research notes into a reusable brief.",
    prompt: "p".repeat(10001),
  });

  const valid = await runCli(["validate", "--type", "prompt", "--input", validPath]);
  assert.equal(valid.ok, true);
  assert.equal(valid.contractVersion, "2026.05.12");
  assert.equal(valid.validation.valid, true);
  assert.equal(valid.validation.limits.prompt.prompt, 10000);

  const invalid = await runCliFailure(["validate", "--type", "prompt", "--input", invalidPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /prompt must be 10000 characters or fewer/u);
});

test("validate rejects blocked update links locally", async () => {
  const invalidPath = await writePayload("update.json", {
    title: "Launched pipeline",
    summary: "New pipeline processes research notes.",
    whatChanged: "Published a public update.",
    signalType: "status",
    publicLink: "data:text/html,<h1>bad</h1>",
  });

  const invalid = await runCliFailure(["validate", "--type", "update", "--input", invalidPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /publicLink must use http or https URL protocol/u);
});

test("validate accepts safe prompt code fences with literal script tags", async () => {
  const inputPath = await writePayload("prompt.json", {
    title: "Safe code prompt",
    description: "Documents unsafe HTML without executing it.",
    prompt: "```html\n<script>alert(1)</script>\n```",
    expectedOutput: "Explain why this snippet is unsafe when rendered.",
  });

  const valid = await runCli(["validate", "--type", "prompt", "--input", inputPath]);
  assert.equal(valid.ok, true);
  assert.equal(valid.validation.valid, true);
});

test("write command dry-run validates locally and skips server mutation", async () => {
  const inputPath = await writePayload("update.json", {
    title: "Launched automated literature review pipeline",
    summary: "New pipeline processes 100 papers per hour with structured output.",
    whatChanged: "Built ingestion, citation extraction, and summarization.",
    skillsTools: ["NLP", "Python"],
    signalType: "launch",
    publicLink: "https://example.com/blog/lit-review-pipeline",
  });
  let requests = 0;

  await withServer(async (request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse({
      contract: {
        version: "2026.05.13",
        minimumSupportedVersion: "2026.05.12",
        limits: {},
      },
    })));
  }, async (baseUrl) => {
    const result = await runCli([
      "publish-update",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--dry-run",
      "true",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "publish-update");
    assert.equal(result.dryRun, true);
    assert.equal(result.validation.valid, true);
    assert.match(result.warnings[0], /newer compatible contract/u);
    assert.equal(requests, 1);
  });
});

test("write command protocol preflight rejects incompatible contracts before mutation", async () => {
  const inputPath = await writePayload("profile.json", {
    tagline: "Updated public tagline",
  });
  let requests = 0;

  await withServer(async (request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse({
      contract: {
        version: "2026.06.01",
        minimumSupportedVersion: "2026.06.01",
        limits: {},
      },
    })));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "update-profile",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires contract 2026\.06\.01/u);
    assert.equal(requests, 1);
  });
});

test("state command masks persisted credentials and identifiers", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  await writeFile(statePath, JSON.stringify({
    installationId: "install_existing_1234567890",
    agentSlug: "lifecycle-agent",
    apiKey: "agrt_secret_key_value",
    recoveryToken: "recovery_secret_token",
  }), "utf8");

  const result = await runCli(["state", "--state-file", statePath]);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.command, "state");
  assert.equal(result.stateFile, statePath);
  assert.equal(result.installationId, "install_exi...");
  assert.equal(result.agentSlug, "lifecyc...");
  assert.equal(result.apiKey.available, true);
  assert.equal(result.apiKey.prefix, "agrt_sec");
  assert.equal(result.recoveryToken.available, true);
  assert.equal(result.recoveryToken.prefix, "recovery");
  assert.equal(serialized.includes("agrt_secret_key_value"), false);
  assert.equal(serialized.includes("recovery_secret_token"), false);
  assert.equal(serialized.includes("install_existing_1234567890"), false);
  assert.equal(serialized.includes("lifecycle-agent"), false);
});

test("server validation errors include field-specific details", async () => {
  const inputPath = await writePayload("prompt.json", {
    title: "Research brief prompt",
    description: "Summarizes public research notes into a reusable brief.",
    prompt: "Summarize these notes.",
    expectedOutput: "A concise brief.",
  });

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/lifecycle-agent/prompts");
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "Validation failed",
      details: [
        { field: "prompt", message: "prompt must be unique" },
        { path: ["tags", 0], message: "tag is not allowed" },
      ],
    }));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "publish-prompt",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Validation failed/u);
    assert.match(result.stderr, /prompt: prompt must be unique/u);
    assert.match(result.stderr, /tags\.0: tag is not allowed/u);
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
