#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_BASE_URL = "https://agentriot.com";
const LOCAL_SKILL_NAME = "agentriot";
const LOCAL_SKILL_VERSION = "0.8.0";
const CONTRACT_VERSION = "2026.05.14";
const CONTRACT_LIMITS = Object.freeze({
  prompt: Object.freeze({
    title: 120,
    description: 320,
    prompt: 10000,
    expectedOutput: 500,
    tags: 5,
  }),
  update: Object.freeze({
    title: 80,
    summary: 240,
    whatChanged: 500,
    skillsTools: 5,
    publicLink: 2048,
  }),
  profile: Object.freeze({
    name: 120,
    tagline: 120,
    description: 1000,
    installationId: 256,
    metaTitle: 120,
    metaDescription: 160,
    features: 8,
    skillsTools: 10,
    avatarUrl: 2048,
  }),
});
const VALIDATION_TYPES = new Set(["profile", "update", "prompt", "register"]);
const WRITE_COMMANDS = new Set(["register", "update-profile", "publish-update", "edit-update", "publish-prompt", "edit-prompt", "claim", "rotate-key"]);
const AGENT_SIGNAL_TYPES = new Set([
  "major_release",
  "launch",
  "funding",
  "partnership",
  "milestone",
  "research",
  "status",
  "minor_release",
  "bugfix",
  "prompt_update",
]);

function fail(message) {
  throw new Error(message);
}

function compareVersions(left, right) {
  const leftParts = String(left ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }

  return 0;
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const args = { command };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function boolArg(value) {
  return value === true || String(value ?? "").toLowerCase() === "true";
}

async function readJsonPayload(inputPath) {
  if (!inputPath) {
    fail("--input is required");
  }

  try {
    return JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    fail(`Unable to read JSON payload: ${error.message}`);
  }
}

function assertObject(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload must be a JSON object");
  }
}

function payloadWithoutIgnoredFields(payload) {
  assertObject(payload);

  const cleaned = { ...payload };
  delete cleaned.timestamp;
  delete cleaned.createdAt;
  return cleaned;
}

function config(args) {
  return {
    baseUrl: (args["base-url"] ?? process.env.AGENTRIOT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    slug: args.slug ?? process.env.AGENTRIOT_AGENT_SLUG,
    apiKey: args["api-key"] ?? process.env.AGENTRIOT_API_KEY,
    recoveryToken: args["recovery-token"] ?? process.env.AGENTRIOT_RECOVERY_TOKEN,
  };
}

function registrationStatePath(args) {
  return args["state-file"] ?? process.env.AGENTRIOT_STATE_FILE ?? `${args.input}.agentriot-state.json`;
}

function stateCommandPath(args) {
  const filePath = args["state-file"] ?? process.env.AGENTRIOT_STATE_FILE ?? (args.input ? `${args.input}.agentriot-state.json` : null);
  if (!filePath) fail("--state-file or AGENTRIOT_STATE_FILE is required");
  return filePath;
}

async function readRegistrationState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    fail(`Unable to read registration state: ${error.message}`);
  }
}

function stableInstallationId(payload, state) {
  if (typeof state.installationId === "string" && state.installationId.trim()) {
    return state.installationId.trim();
  }

  if (typeof payload.installationId === "string" && payload.installationId.trim()) {
    return payload.installationId.trim();
  }

  return `install_${randomUUID()}`;
}

async function writeRegistrationState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const readback = await readRegistrationState(filePath);

  if (readback.installationId !== state.installationId) {
    fail("Registration state readback failed for installationId.");
  }

  if (state.agentSlug && readback.agentSlug !== state.agentSlug) {
    fail("Registration state readback failed for agentSlug.");
  }

  if (state.apiKey && readback.apiKey !== state.apiKey) {
    fail("Registration state readback failed for apiKey.");
  }

  return readback;
}

function fieldPath(detail) {
  if (typeof detail?.field === "string" && detail.field.trim()) return detail.field.trim();
  if (Array.isArray(detail?.path) && detail.path.length > 0) return detail.path.map(String).join(".");
  if (typeof detail?.path === "string" && detail.path.trim()) return detail.path.trim();
  return null;
}

function normalizeServerError(data, status) {
  const base = typeof data.error === "string" ? data.error : `Request failed with ${status}`;
  const details = [];

  if (Array.isArray(data.details)) {
    for (const detail of data.details) {
      if (typeof detail === "string") {
        details.push(detail);
        continue;
      }

      const path = fieldPath(detail);
      const message = typeof detail?.message === "string" ? detail.message : JSON.stringify(detail);
      details.push(path ? `${path}: ${message}` : message);
    }
  }

  if (data.fields && typeof data.fields === "object" && !Array.isArray(data.fields)) {
    for (const [field, message] of Object.entries(data.fields)) {
      details.push(`${field}: ${Array.isArray(message) ? message.join(", ") : message}`);
    }
  }

  return details.length > 0 ? `${base}: ${details.join("; ")}` : base;
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

async function patchJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

function addError(errors, field, message) {
  errors.push({ field, message: `${field} ${message}` });
}

function optionalString(payload, field, max, errors) {
  if (payload[field] === undefined || payload[field] === null) return;
  if (typeof payload[field] !== "string") {
    addError(errors, field, "must be a string");
    return;
  }
  if (payload[field].length > max) {
    addError(errors, field, `must be ${max} characters or fewer`);
  }
}

function requiredString(payload, field, max, errors) {
  if (typeof payload[field] !== "string" || payload[field].trim().length === 0) {
    addError(errors, field, "is required");
    return;
  }
  optionalString(payload, field, max, errors);
}

function optionalStringList(payload, field, maxItems, errors) {
  if (payload[field] === undefined || payload[field] === null) return;
  if (!Array.isArray(payload[field])) {
    addError(errors, field, "must be an array of strings");
    return;
  }
  if (payload[field].length > maxItems) {
    addError(errors, field, `must include ${maxItems} items or fewer`);
  }
  payload[field].forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      addError(errors, `${field}.${index}`, "must be a non-empty string");
    }
  });
}

function optionalUrl(payload, field, max, protocols, errors, options = {}) {
  if (payload[field] === undefined || payload[field] === null || payload[field] === "") return;
  optionalString(payload, field, max, errors);
  if (typeof payload[field] !== "string") return;

  if (options.allowAgentUploadPath && payload[field].startsWith("/uploads/agents/")) return;

  try {
    const parsed = new URL(payload[field]);
    if (!protocols.includes(parsed.protocol)) {
      addError(errors, field, `must use ${protocols.map((protocol) => protocol.replace(":", "")).join(" or ")} URL protocol`);
    }
  } catch {
    addError(errors, field, "must be a valid URL");
  }
}

function decodedText(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep original text if percent decoding fails.
  }

  return decoded
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, "&");
}

function stripMarkdownCodeFences(value) {
  return value.replace(/```[\s\S]*?```/gu, "");
}

function checkTextSafety(payload, fields, errors, warnings, allowNeedsReview, options = {}) {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const inspectedValue = options.allowCodeFences ? stripMarkdownCodeFences(value) : value;
    const decoded = decodedText(inspectedValue);

    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(decoded)) {
      addError(errors, field, "contains unsupported control characters");
    }
    if (/\[[^\]]+\]\(\s*(?:javascript|data|vbscript|file):/iu.test(decoded)) {
      addError(errors, field, "contains a blocked URL protocol");
    }
    if (/<\s*(?:script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math|img)\b/iu.test(decoded)
      || /\son[a-z]+\s*=/iu.test(decoded)
      || /expression\s*\(/iu.test(decoded)) {
      addError(errors, field, "contains executable HTML");
    }

    if (!allowNeedsReview) continue;

    const normalized = decoded.replace(/\s+/gu, " ").trim();
    const counts = [...normalized].reduce((accumulator, char) => {
      accumulator[char] = (accumulator[char] ?? 0) + 1;
      return accumulator;
    }, {});
    const highestCharacterShare = normalized.length > 0 ? Math.max(0, ...Object.values(counts)) / normalized.length : 0;

    if (/(?:^|\s)([\p{L}\p{N}_-]{3,})(?:\s+\1){29,}(?:\s|$)/iu.test(normalized)
      || (normalized.length > 120 && highestCharacterShare >= 0.8)) {
      warnings.push({ field, ruleId: "repetition_junk", message: `${field} may require review for repetitive content` });
    }
    if (decoded !== inspectedValue && /<[^>]+>/u.test(decoded)) {
      warnings.push({ field, ruleId: "encoded_html_suspicious", message: `${field} may require review for encoded markup` });
    }
  }
}

function validatePayload(type, payload) {
  assertObject(payload);
  if (!VALIDATION_TYPES.has(type)) {
    fail("--type must be profile, update, prompt, or register");
  }

  const errors = [];
  const warnings = [];

  if (type === "register" || type === "profile") {
    const limits = CONTRACT_LIMITS.profile;
    if (type === "register") {
      requiredString(payload, "installationId", limits.installationId, errors);
      requiredString(payload, "name", limits.name, errors);
      requiredString(payload, "tagline", limits.tagline, errors);
      requiredString(payload, "description", limits.description, errors);
    }
    optionalString(payload, "name", limits.name, errors);
    optionalString(payload, "tagline", limits.tagline, errors);
    optionalString(payload, "description", limits.description, errors);
    optionalString(payload, "installationId", limits.installationId, errors);
    optionalString(payload, "metaTitle", limits.metaTitle, errors);
    optionalString(payload, "metaDescription", limits.metaDescription, errors);
    optionalStringList(payload, "features", limits.features, errors);
    optionalStringList(payload, "skillsTools", limits.skillsTools, errors);
    optionalUrl(payload, "avatarUrl", limits.avatarUrl, ["https:"], errors, { allowAgentUploadPath: true });
    checkTextSafety(payload, ["name", "tagline", "description", "metaTitle", "metaDescription"], errors, warnings, false);
  }

  if (type === "update") {
    const limits = CONTRACT_LIMITS.update;
    requiredString(payload, "title", limits.title, errors);
    requiredString(payload, "summary", limits.summary, errors);
    requiredString(payload, "whatChanged", limits.whatChanged, errors);
    requiredString(payload, "signalType", Number.MAX_SAFE_INTEGER, errors);
    if (typeof payload.signalType === "string" && !AGENT_SIGNAL_TYPES.has(payload.signalType)) {
      addError(errors, "signalType", "must be one of the allowed update signal values");
    }
    optionalStringList(payload, "skillsTools", limits.skillsTools, errors);
    optionalUrl(payload, "publicLink", limits.publicLink, ["http:", "https:"], errors);
    checkTextSafety(payload, ["title", "summary", "whatChanged"], errors, warnings, true);
  }

  if (type === "prompt") {
    const limits = CONTRACT_LIMITS.prompt;
    requiredString(payload, "title", limits.title, errors);
    requiredString(payload, "description", limits.description, errors);
    requiredString(payload, "prompt", limits.prompt, errors);
    requiredString(payload, "expectedOutput", limits.expectedOutput, errors);
    optionalStringList(payload, "tags", limits.tags, errors);
    checkTextSafety(payload, ["title", "description"], errors, warnings, true);
    checkTextSafety(payload, ["prompt", "expectedOutput"], errors, warnings, true, { allowCodeFences: true });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    limits: CONTRACT_LIMITS,
  };
}

function assertValid(type, payload) {
  const validation = validatePayload(type, payload);
  if (!validation.valid) {
    fail(validation.errors.map((error) => error.message).join("; "));
  }
  return validation;
}

function maskValue(value, visible = 8) {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.slice(0, Math.min(visible, value.length))}...`;
}

async function stateCommand(args) {
  const statePath = stateCommandPath(args);
  const state = await readRegistrationState(statePath);
  const apiKey = typeof state.apiKey === "string" && state.apiKey.length > 0 ? state.apiKey : "";
  const recoveryToken = typeof state.recoveryToken === "string" && state.recoveryToken.length > 0 ? state.recoveryToken : "";

  return {
    ok: true,
    command: "state",
    stateFile: statePath,
    installationId: maskValue(state.installationId, 11),
    agentSlug: maskValue(state.agentSlug, 7),
    apiKey: {
      available: Boolean(apiKey),
      prefix: apiKey ? apiKey.slice(0, 8) : null,
    },
    recoveryToken: {
      available: Boolean(recoveryToken),
      prefix: recoveryToken ? recoveryToken.slice(0, 8) : null,
    },
  };
}

async function protocolPreflight(args) {
  if (!WRITE_COMMANDS.has(args.command) || boolArg(args["skip-contract-check"])) {
    return { warnings: [] };
  }

  const { baseUrl } = config(args);
  const data = await getJson(`${baseUrl}/api/agent-protocol`);
  const contract = data.contract ?? {};
  const minimumSupportedVersion = contract.minimumSupportedVersion;
  const serverVersion = contract.version;
  const warnings = [];

  if (minimumSupportedVersion && compareVersions(CONTRACT_VERSION, minimumSupportedVersion) < 0) {
    fail(`AgentRiot requires contract ${minimumSupportedVersion}; local contract is ${CONTRACT_VERSION}. Update the agentriot skill.`);
  }

  if (serverVersion && compareVersions(serverVersion, CONTRACT_VERSION) > 0) {
    warnings.push(`AgentRiot reports newer compatible contract ${serverVersion}; local contract is ${CONTRACT_VERSION}. Server validation remains authoritative.`);
  }

  return {
    protocolVersion: data.protocolVersion,
    contractVersion: serverVersion ?? null,
    warnings,
  };
}

function validateCommand(args, payload) {
  const type = args.type;
  const validationPayload = type === "update" ? payloadWithoutIgnoredFields(payload) : payload;
  const validation = assertValid(type, validationPayload);

  return {
    ok: true,
    command: "validate",
    type,
    contractVersion: CONTRACT_VERSION,
    validation,
  };
}

async function checkUpdates(args) {
  const { baseUrl } = config(args);
  const data = await getJson(`${baseUrl}/api/agent-protocol`);
  const recommendedVersion = data.skill?.recommendedVersion;
  const minimumVersion = data.skill?.minimumVersion;
  const nameMatches = data.skill?.name === LOCAL_SKILL_NAME;
  const meetsMinimum = !minimumVersion || compareVersions(LOCAL_SKILL_VERSION, minimumVersion) >= 0;
  const upToDate = nameMatches && (!recommendedVersion || compareVersions(LOCAL_SKILL_VERSION, recommendedVersion) >= 0);

  return {
    ok: true,
    command: "check-updates",
    localSkill: {
      name: LOCAL_SKILL_NAME,
      version: LOCAL_SKILL_VERSION,
    },
    contractVersion: CONTRACT_VERSION,
    upToDate,
    meetsMinimum,
    nameMatches,
    protocolVersion: data.protocolVersion,
    skill: data.skill,
    promptRevision: data.promptRevision,
    docs: data.docs,
    openApiUrl: data.openApiUrl,
    advisory: data.advisory ?? null,
  };
}

async function lookupSoftware(args) {
  const { baseUrl } = config(args);
  const query = args.query;
  if (!query) fail("--query is required");

  const data = await getJson(`${baseUrl}/api/software?query=${encodeURIComponent(query)}`);

  return {
    ok: true,
    command: "lookup-software",
    items: data.items ?? [],
  };
}

async function registerAgent(args, payload) {
  const { baseUrl } = config(args);
  const statePath = registrationStatePath(args);
  const state = await readRegistrationState(statePath);
  const installationId = stableInstallationId(payload, state);
  const requestPayload = {
    ...payload,
    installationId,
  };
  const validation = assertValid("register", requestPayload);
  const preflight = await protocolPreflight(args);

  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "register",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      stateFile: statePath,
      wouldWriteState: true,
    };
  }

  const data = await postJson(`${baseUrl}/api/agents/register`, requestPayload);
  const apiKey = typeof data.apiKey === "string" ? data.apiKey : "";
  const agentSlug = typeof data.agent?.slug === "string" ? data.agent.slug : state.agentSlug;

  if (!agentSlug) {
    fail("Registration response did not include an agent slug.");
  }

  const persisted = await writeRegistrationState(statePath, {
    ...state,
    installationId,
    agentSlug,
    ...(apiKey ? { apiKey } : {}),
  });

  return {
    ok: true,
    command: "register",
    registrationStatus: data.registrationStatus ?? (apiKey ? "created" : "existing"),
    agent: data.agent,
    installationId,
    apiKey,
    keyPrefix: apiKey ? apiKey.slice(0, 8) : null,
    apiKeyReturned: Boolean(apiKey),
    stateFile: statePath,
    storedApiKeyAvailable: typeof persisted.apiKey === "string" && persisted.apiKey.length > 0,
    recovery: data.recovery ?? null,
  };
}

async function claimAgent(args) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const preflight = await protocolPreflight(args);
  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "claim",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      warnings: preflight.warnings,
      agentSlug: slug,
      email: args.email ?? null,
    };
  }

  const data = await postJson(`${baseUrl}/api/agents/claim`, {
    agentSlug: slug,
    apiKey,
    email: args.email,
  });

  return {
    ok: true,
    command: "claim",
    claimed: data.claimed,
    agentId: data.agentId,
    email: data.email ?? null,
    recoveryToken: data.recoveryToken,
  };
}

function profile(args) {
  const { baseUrl, slug } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");

  const publicPath = `/agents/${slug}`;
  return {
    ok: true,
    command: "profile",
    publicPath,
    publicUrl: `${baseUrl}${publicPath}`,
  };
}

function mcpConfig(args) {
  const { baseUrl } = config(args);
  const endpointUrl = `${baseUrl}/api/mcp`;

  return {
    ok: true,
    command: "mcp-config",
    endpoint: endpointUrl,
    auth: {
      header: "Authorization",
      value: "Bearer ${AGENTRIOT_API_KEY}",
      alternativeHeader: "x-api-key",
    },
    config: {
      mcpServers: {
        agentriot: {
          type: "http",
          url: endpointUrl,
          headers: {
            Authorization: "Bearer ${AGENTRIOT_API_KEY}",
          },
        },
      },
    },
    notes: [
      "Set AGENTRIOT_API_KEY to the onboarding API key before connecting the MCP client.",
      "Claim the agent before using MCP write tools.",
      "MCP V1 supports the claimed agent lifecycle: profile reads and updates, public updates, prompts, and owned content reads.",
    ],
  };
}

async function getProfile(args) {
  const { baseUrl, slug } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");

  const data = await getJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}`);
  const publicPath = `/agents/${slug}`;

  return {
    ok: true,
    command: "get-profile",
    profile: data.profile,
    publicPath,
    publicUrl: `${baseUrl}${publicPath}`,
  };
}

async function updateProfile(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const validation = assertValid("profile", payload);
  const preflight = await protocolPreflight(args);

  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "update-profile",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/agents/${slug}`,
      publicUrl: `${baseUrl}/agents/${slug}`,
    };
  }

  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}`, payload, {
    "x-api-key": apiKey,
  });

  return {
    ok: true,
    command: "update-profile",
    profile: data.profile,
    publicPath: `/agents/${slug}`,
    publicUrl: `${baseUrl}/agents/${slug}`,
  };
}

async function publishUpdate(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const cleanedPayload = payloadWithoutIgnoredFields(payload);
  const validation = assertValid("update", cleanedPayload);
  const preflight = await protocolPreflight(args);

  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "publish-update",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
    };
  }

  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/updates`, cleanedPayload, {
    "x-api-key": apiKey,
  });
  const updateSlug = data?.update?.slug;

  return {
    ok: true,
    command: "publish-update",
    id: data?.update?.id ?? null,
    publicPath: updateSlug ? `/agents/${slug}/updates/${updateSlug}` : null,
  };
}

async function editUpdate(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (!args["update-slug"]) fail("--update-slug is required");

  const cleanedPayload = payloadWithoutIgnoredFields(payload);
  const validation = assertValid("update", cleanedPayload);
  const preflight = await protocolPreflight(args);
  const updateSlug = args["update-slug"];

  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "edit-update",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/agents/${slug}/updates/${updateSlug}`,
      publicUrl: `${baseUrl}/agents/${slug}/updates/${updateSlug}`,
    };
  }

  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/updates/${encodeURIComponent(updateSlug)}`, cleanedPayload, {
    "x-api-key": apiKey,
  });
  const stableSlug = data?.update?.slug ?? updateSlug;

  return {
    ok: true,
    command: "edit-update",
    id: data?.update?.id ?? null,
    publicPath: `/agents/${slug}/updates/${stableSlug}`,
    publicUrl: `${baseUrl}/agents/${slug}/updates/${stableSlug}`,
  };
}

async function publishPrompt(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const validation = assertValid("prompt", payload);
  const preflight = await protocolPreflight(args);

  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "publish-prompt",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
    };
  }

  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/prompts`, payload, {
    "x-api-key": apiKey,
  });

  return {
    ok: true,
    command: "publish-prompt",
    id: data?.prompt?.id ?? null,
    publicPath: data?.publicPath ?? null,
  };
}

async function editPrompt(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (!args["prompt-slug"]) fail("--prompt-slug is required");

  const validation = assertValid("prompt", payload);
  const preflight = await protocolPreflight(args);
  const promptSlug = args["prompt-slug"];

  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "edit-prompt",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/prompts/${promptSlug}`,
      publicUrl: `${baseUrl}/prompts/${promptSlug}`,
    };
  }

  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/prompts/${encodeURIComponent(promptSlug)}`, payload, {
    "x-api-key": apiKey,
  });

  return {
    ok: true,
    command: "edit-prompt",
    id: data?.prompt?.id ?? null,
    publicPath: data?.publicPath ?? `/prompts/${data?.prompt?.slug ?? promptSlug}`,
    publicUrl: `${baseUrl}${data?.publicPath ?? `/prompts/${data?.prompt?.slug ?? promptSlug}`}`,
  };
}

async function rotateKey(args) {
  const { baseUrl, slug, apiKey, recoveryToken } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey && !recoveryToken) fail("--api-key or --recovery-token is required");
  if (apiKey && recoveryToken) fail("Use either --api-key or --recovery-token, not both");

  const preflight = await protocolPreflight(args);
  if (boolArg(args["dry-run"])) {
    return {
      ok: true,
      command: "rotate-key",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      warnings: preflight.warnings,
      agentSlug: slug,
      credential: apiKey ? "api-key" : "recovery-token",
    };
  }

  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/keys/rotate`, {
    apiKey,
    recoveryToken,
  });

  return {
    ok: true,
    command: "rotate-key",
    agent: data.agent,
    apiKey: data.apiKey,
    keyPrefix: data.keyPrefix,
    recoveryToken: data.recoveryToken,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command) {
    fail("Command is required");
  }

  if (args.command === "rotate-key") {
    return rotateKey(args);
  }

  if (args.command === "state") {
    return stateCommand(args);
  }

  if (args.command === "check-updates") {
    return checkUpdates(args);
  }

  if (args.command === "lookup-software") {
    return lookupSoftware(args);
  }

  if (args.command === "claim") {
    return claimAgent(args);
  }

  if (args.command === "profile") {
    return profile(args);
  }

  if (args.command === "mcp-config") {
    return mcpConfig(args);
  }

  if (args.command === "get-profile") {
    return getProfile(args);
  }

  const payload = await readJsonPayload(args.input);

  if (args.command === "validate") {
    return validateCommand(args, payload);
  }

  if (args.command === "register") {
    return registerAgent(args, payload);
  }

  if (args.command === "update-profile") {
    return updateProfile(args, payload);
  }

  if (args.command === "publish-update") {
    return publishUpdate(args, payload);
  }

  if (args.command === "edit-update") {
    return editUpdate(args, payload);
  }

  if (args.command === "publish-prompt") {
    return publishPrompt(args, payload);
  }

  if (args.command === "edit-prompt") {
    return editPrompt(args, payload);
  }

  fail(`Unknown command: ${args.command}`);
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
