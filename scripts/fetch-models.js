#!/usr/bin/env node
/**
 * fetch-models.js
 *
 * Fetches all currently available FREE AI models from every configured
 * SOURCE (OpenRouter, Kilo Gateway, and any others you wire up — see
 * "Auto-fetch sources" below), merges in manually-configured custom
 * providers, and writes:
 *   - data/models.json          — current snapshot
 *   - data/history/YYYY-MM-DD.json — daily archive
 *   - README.md                 — regenerated table section
 *
 * Run: node scripts/fetch-models.js
 * Intended to run daily (e.g. via GitHub Actions cron) since gateways add
 * and remove free models frequently.
 *
 * Auto-fetch sources (no API key needed to list models):
 *   - OpenRouter   https://openrouter.ai/api/v1/models
 *   - Kilo Gateway https://api.kilo.ai/api/gateway/models
 *   Add more by pushing another entry into the SOURCES array below — each
 *   source is just an async function that returns an array of normalised
 *   model objects. A fetch failure in one source logs a warning and is
 *   skipped; it never aborts the whole run.
 *
 * Manually-maintained providers (config/custom-providers.json):
 *   Some gateways (AIHubMix, TokenRouter, etc.) require an API key just to
 *   list their catalog, so they can't be safely auto-fetched here without
 *   you providing credentials. Add/edit/remove those by hand in
 *   config/custom-providers.json — see that file's "_schema" block. Entries
 *   there always take precedence over auto-fetched ones with the same id.
 *   Point at a different config file with --config=/path/to/file.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArgValue(flag) {
  const prefix = `--${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const CONFIG_PATH =
  getArgValue("config") ?? join(ROOT, "config", "custom-providers.json");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
fetch-models.js — track free AI models

Usage:
  node scripts/fetch-models.js [options]

Options:
  --config=PATH   Path to a custom providers JSON file
                  (default: config/custom-providers.json)
  --help, -h      Show this help

To add your own provider permanently, edit:
  ${CONFIG_PATH}
and add an object to the "providers" array, e.g.:
  {
    "id":             "myhost/my-model",
    "name":           "My Model",
    "provider":       "My Host",
    "context_window": 32000,
    "modalities":     ["text"],
    "rate_limit":     "60 req/min",
    "notes":          "Free tier, requires signup",
    "source":         "https://example.com"
  }
`);
  process.exit(0);
}

// ── Known rate limits per provider (requests/minute unless noted) ──────────────
const RATE_LIMITS = {
  "google/gemini":         "15 req/min · 1M tokens/day",
  "meta-llama":            "30 req/min",
  "deepseek":              "20 req/min",
  "qwen":                  "20 req/min",
  "mistralai":             "5 req/min",
  "microsoft":             "10 req/min",
  "nvidia":                "40 req/min",
  "nousresearch":          "20 req/min",
  "liquid":                "10 req/min",
  "sophosympatheia":       "20 req/min",
};

function getRateLimit(modelId) {
  for (const [prefix, limit] of Object.entries(RATE_LIMITS)) {
    if (modelId.includes(prefix)) return limit;
  }
  return "varies";
}

// ── Modality icons ─────────────────────────────────────────────────────────────
function modalityBadge(modality) {
  const map = {
    text:  "💬 text",
    image: "🖼️ vision",
    file:  "📄 files",
  };
  return map[modality] ?? modality;
}

// ── Format context window ──────────────────────────────────────────────────────
function fmtCtx(n) {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── Auto-fetch sources ───────────────────────────────────────────────────────
// Each source is an async function that returns an array of ALREADY-normalised
// model objects (same shape as normaliseCustomProvider() produces). Add a new
// gateway by writing one of these and pushing it into SOURCES at the bottom.

async function fetchOpenRouterModels() {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { "User-Agent": "free-ai-models-tracker/1.0 (github.com/ClawLabsAI/free-ai-models)" },
  });
  if (!res.ok) throw new Error(`OpenRouter API ${res.status}: ${res.statusText}`);
  const { data } = await res.json();

  // Free models have pricing.prompt === "0" && pricing.completion === "0"
  const freeModels = data.filter(
    (m) =>
      m.pricing &&
      (m.pricing.prompt === "0" || parseFloat(m.pricing.prompt) === 0) &&
      (m.pricing.completion === "0" || parseFloat(m.pricing.completion) === 0)
  );

  console.log(`✅ OpenRouter: ${freeModels.length} free models`);

  return freeModels.map((m) => {
    const providerSlug = m.id.split("/")[0];
    const providerName =
      providerSlug.charAt(0).toUpperCase() + providerSlug.slice(1).replace(/-/g, " ");
    const inputModalities  = m.architecture?.input_modalities  ?? ["text"];
    const outputModalities = m.architecture?.output_modalities ?? ["text"];
    const allModalities    = [...new Set([...inputModalities, ...outputModalities])];

    return {
      id:             m.id,
      name:           m.name,
      provider:       providerName,
      context_window: m.context_length ?? 0,
      max_output:     m.top_provider?.max_completion_tokens ?? null,
      modalities:     allModalities,
      rate_limit:     getRateLimit(m.id),
      notes:          "",
      source:         `https://openrouter.ai/${m.id}`,
      created:        m.created ?? null,
    };
  });
}

// Kilo Gateway publishes its full catalog with no API key required:
// GET https://api.kilo.ai/api/gateway/models
// Response shape (per model): { id, name, cost: {input, output}, limit:
// {context, output}, modalities: {input: [...], output: [...]}, options:
// {description}, release_date }. Free models have cost.input/output === 0,
// or an id/name ending in "-free" / "/free" (e.g. kilo-auto/free).
async function fetchKiloModels() {
  const res = await fetch("https://api.kilo.ai/api/gateway/models", {
    headers: { "User-Agent": "free-ai-models-tracker/1.0 (github.com/ClawLabsAI/free-ai-models)" },
  });
  if (!res.ok) throw new Error(`Kilo Gateway API ${res.status}: ${res.statusText}`);
  const body = await res.json();

  // Be defensive about response shape: could be a bare array, {data: [...]},
  // or an object keyed by model id.
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Object.values(body ?? {});

  const isFree = (m) => {
    const cost = m.cost ?? m.pricing ?? {};
    const zeroCost =
      (cost.input === 0 || cost.input === "0") &&
      (cost.output === 0 || cost.output === "0");
    const freeName = /(^|\/|-)free$/i.test(m.id ?? "") || /(^|\/|-)free$/i.test(m.name ?? "");
    return zeroCost || freeName;
  };

  const free = list.filter(isFree);
  console.log(`✅ Kilo Gateway: ${free.length} free models`);

  return free.map((m) => {
    const inputModalities  = m.modalities?.input  ?? ["text"];
    const outputModalities = m.modalities?.output ?? ["text"];
    const allModalities    = [...new Set([...inputModalities, ...outputModalities])];

    return {
      id:             `kilo/${m.id}`,
      name:           m.name ?? m.id,
      provider:       "Kilo Gateway",
      context_window: m.limit?.context ?? 0,
      max_output:     m.limit?.output ?? null,
      modalities:     allModalities,
      rate_limit:     "200 req/hour (anonymous, no auth) · higher for signed-in accounts",
      notes:          m.options?.description ?? "",
      source:         "https://kilo.ai/docs/gateway/models-and-providers",
      created:        m.release_date ?? null,
    };
  });
}

// Register every auto-fetch source here. Each entry: { name, fetch }.
// A failure in one source is caught, logged, and skipped — it never aborts
// the whole run (see runSources() in main()).
const SOURCES = [
  { name: "OpenRouter",   fetch: fetchOpenRouterModels },
  { name: "Kilo Gateway", fetch: fetchKiloModels },
  // Add more here, e.g.:
  // { name: "SomeGateway", fetch: fetchSomeGatewayModels },
];

async function runSources() {
  const results = [];
  for (const { name, fetch: fetchFn } of SOURCES) {
    try {
      const models = await fetchFn();
      results.push(...models);
    } catch (err) {
      console.warn(`⚠️  Skipping source "${name}" — ${err.message}`);
    }
  }
  return results;
}

// ── Custom / extra providers (user-editable) ────────────────────────────────────
const REQUIRED_FIELDS = ["id", "name", "provider", "source"];

function validateProvider(p, originLabel) {
  const missing = REQUIRED_FIELDS.filter((f) => !p[f]);
  if (missing.length) {
    console.warn(
      `⚠️  Skipping custom provider from ${originLabel} — missing field(s): ${missing.join(", ")}`
    );
    return false;
  }
  return true;
}

function normaliseCustomProvider(p) {
  return {
    id:             p.id,
    name:           p.name,
    provider:       p.provider,
    context_window: p.context_window ?? 0,
    max_output:     p.max_output ?? null,
    modalities:     p.modalities ?? ["text"],
    rate_limit:     p.rate_limit ?? "varies",
    notes:          p.notes ?? "",
    source:         p.source,
    created:        p.created ?? null,
  };
}

function loadCustomProviders(configPath) {
  if (!existsSync(configPath)) {
    console.log(`ℹ️  No custom provider config found at ${configPath} — skipping (this is optional).`);
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.warn(`⚠️  Could not parse ${configPath}: ${err.message}. Skipping custom providers.`);
    return [];
  }

  const list = Array.isArray(raw) ? raw : raw.providers;
  if (!Array.isArray(list)) {
    console.warn(
      `⚠️  ${configPath} must be either a JSON array of providers, or an object with a "providers" array. Skipping.`
    );
    return [];
  }

  const valid = list.filter((p) => validateProvider(p, configPath));
  console.log(`✅ Loaded ${valid.length} custom provider(s) from ${configPath}`);
  return valid.map(normaliseCustomProvider);
}

// Merge custom providers on top of OpenRouter results: entries whose "id"
// matches an existing model override it, new ids are appended.
function mergeModels(base, custom) {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const c of custom) {
    if (byId.has(c.id)) {
      console.log(`   ↳ overriding existing entry: ${c.id}`);
    }
    byId.set(c.id, { ...byId.get(c.id), ...c });
  }
  return [...byId.values()];
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`⏳ Fetching models from ${SOURCES.length} source(s): ${SOURCES.map((s) => s.name).join(", ")}…`);
  const fetched = await runSources();
  console.log(`✅ ${fetched.length} free models fetched across all sources`);

  // Load and merge custom / extra providers from the editable config file.
  // These take precedence over auto-fetched entries with the same id.
  const customProviders = loadCustomProviders(CONFIG_PATH);
  const all = mergeModels(fetched, customProviders);

  // Sort: context window desc
  all.sort((a, b) => (b.context_window ?? 0) - (a.context_window ?? 0));

  const updatedAt = new Date().toISOString();
  const snapshot = {
    updated_at:        updatedAt,
    total_free_models: all.length,
    sources:           [
      ...SOURCES.map((s) => s.name),
      ...(customProviders.length ? [CONFIG_PATH] : []),
    ],
    models:            all,
  };

  // Write data/models.json
  const modelsPath = join(ROOT, "data", "models.json");
  writeFileSync(modelsPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`💾 Written ${modelsPath}`);

  // Write daily history snapshot
  const dateStr = new Date().toISOString().slice(0, 10);
  const histDir = join(ROOT, "data", "history");
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const histPath = join(histDir, `${dateStr}.json`);
  writeFileSync(histPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`📅 History snapshot: ${histPath}`);

  // Regenerate README table
  await updateReadme(all, updatedAt);

  console.log(`\n🎉 Done — ${all.length} free models tracked`);
}

// ── README generation ──────────────────────────────────────────────────────────
async function updateReadme(models, updatedAt) {
  const readmePath = join(ROOT, "README.md");
  const readme     = readFileSync(readmePath, "utf8");

  const dateLabel = new Date(updatedAt).toUTCString().replace(" GMT", " UTC");

  const header = [
    `| # | Model | Provider | Context | Modalities | Rate Limit | Source |`,
    `|---|-------|----------|---------|------------|------------|--------|`,
  ].join("\n");

  const rows = models.map((m, i) => {
    const ctx         = fmtCtx(m.context_window);
    const modalities  = (m.modalities ?? ["text"]).map(modalityBadge).join(", ");
    const rateLimit   = m.rate_limit ?? "varies";
    const source      = `[link](${m.source})`;
    return `| ${i + 1} | **${m.name}** | ${m.provider} | ${ctx} | ${modalities} | ${rateLimit} | ${source} |`;
  });

  const tableBlock = [
    `<!-- TABLE_START -->`,
    `> Last updated: **${dateLabel}** · ${models.length} models tracked`,
    ``,
    header,
    rows.join("\n"),
    `<!-- TABLE_END -->`,
  ].join("\n");

  const updated = readme.replace(
    /<!-- TABLE_START -->[\s\S]*?<!-- TABLE_END -->/,
    tableBlock
  );

  writeFileSync(readmePath, updated, "utf8");
  console.log(`📝 README.md updated`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
