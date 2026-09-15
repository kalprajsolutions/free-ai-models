#!/usr/bin/env node
/**
 * fetch-models.js
 *
 * Fetches all currently available FREE AI models from OpenRouter's public API
 * (no API key required), enriches with known metadata, merges in any custom
 * providers the user has configured, and writes:
 *   - data/models.json          — current snapshot
 *   - data/history/YYYY-MM-DD.json — daily archive
 *   - README.md                 — regenerated table section
 *
 * Run: node scripts/fetch-models.js
 *
 * Custom providers:
 *   Edit config/custom-providers.json to add, override, or remove your own
 *   free-model entries without touching this script. See that file's
 *   "_schema" block for the expected shape of each entry. You can also point
 *   at a different config file with --config=/path/to/file.json, or add an
 *   ad-hoc entry from the command line with --add (see printed help below).
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

// ── Fetch from OpenRouter ──────────────────────────────────────────────────────
async function fetchOpenRouterModels() {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { "User-Agent": "free-ai-models-tracker/1.0 (github.com/ClawLabsAI/free-ai-models)" },
  });
  if (!res.ok) throw new Error(`OpenRouter API ${res.status}: ${res.statusText}`);
  const { data } = await res.json();
  return data;
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
  console.log("⏳ Fetching models from OpenRouter…");
  const allModels = await fetchOpenRouterModels();

  // Filter: free models have pricing.prompt === "0" && pricing.completion === "0"
  const freeModels = allModels.filter(
    (m) =>
      m.pricing &&
      (m.pricing.prompt === "0" || parseFloat(m.pricing.prompt) === 0) &&
      (m.pricing.completion === "0" || parseFloat(m.pricing.completion) === 0)
  );

  console.log(`✅ Found ${freeModels.length} free models on OpenRouter`);

  // Normalise OpenRouter models
  const normalised = freeModels.map((m) => {
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
      modalities:     allModalities.filter((x) => x !== "text" || true),
      rate_limit:     getRateLimit(m.id),
      notes:          "",
      source:         `https://openrouter.ai/${m.id}`,
      created:        m.created ?? null,
    };
  });

  // Load and merge custom / extra providers from the editable config file
  const customProviders = loadCustomProviders(CONFIG_PATH);
  const all = mergeModels(normalised, customProviders);

  // Sort: context window desc
  all.sort((a, b) => (b.context_window ?? 0) - (a.context_window ?? 0));

  const updatedAt = new Date().toISOString();
  const snapshot = {
    updated_at:        updatedAt,
    total_free_models: all.length,
    sources:           [
      "openrouter.ai/api/v1/models",
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
