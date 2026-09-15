#!/usr/bin/env node
/**
 * fetch-models.js
 *
 * Fetches all currently available FREE AI models from every source listed in
 * config/sources.json (OpenRouter, Kilo Gateway, AIHubMix, TokenRouter, and
 * any others you add), merges in manually-configured custom providers, and
 * writes:
 *   - data/models.json             — current snapshot
 *   - data/history/YYYY-MM-DD.json — daily archive
 *   - README.md                    — regenerated table section
 *
 * Run: node scripts/fetch-models.js
 * Intended to run daily (e.g. via GitHub Actions cron) since gateways add
 * and remove free models frequently.
 *
 * Auto-fetch sources (config/sources.json):
 *   Each entry describes one gateway catalog. "format" selects the response
 *   normalizer:
 *     - "openrouter" — OpenRouter-style catalog. Also matches the Kilo
 *       Gateway API (https://api.kilo.ai/api/gateway/models), which returns
 *       the same shape: data[].pricing.{prompt,completion} as strings,
 *       data[].architecture.{input,output}_modalities, top_provider, etc.
 *     - "aihubmix"   — AIHubMix catalog (https://aihubmix.com/api/v1/models):
 *       data[].pricing.{input,output} as numbers, comma-separated modality
 *       strings, retire_stage filtering.
 *     - "openai"     — plain OpenAI-compatible /models listing (e.g.
 *       TokenRouter). These usually carry no pricing info, so free models
 *       are detected by name suffix (see "free_filter").
 *   Gateways that need an API key just to LIST their catalog (TokenRouter)
 *   declare "api_key_env". If that env var is set the key is sent as a Bearer
 *   token; if it's required but missing, the source is skipped with a notice —
 *   it never aborts the whole run.
 *
 * Manually-maintained providers (config/custom-providers.json):
 *   For gateways/models that can't be auto-fetched at all (e.g. Pollinations,
 *   which has no catalog API). Entries there always take precedence over
 *   auto-fetched ones with the same id. Point either file somewhere else with
 *   --sources=PATH / --config=PATH.
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

const SOURCES_PATH =
  getArgValue("sources") ?? join(ROOT, "config", "sources.json");
const CONFIG_PATH =
  getArgValue("config") ?? join(ROOT, "config", "custom-providers.json");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
fetch-models.js — track free AI models

Usage:
  node scripts/fetch-models.js [options]

Options:
  --sources=PATH  Path to the auto-fetch sources config
                  (default: config/sources.json)
  --config=PATH   Path to a custom providers JSON file
                  (default: config/custom-providers.json)
  --help, -h      Show this help

To add an auto-fetched gateway permanently, edit ${SOURCES_PATH}:
  {
    "name":        "MyGateway",
    "url":         "https://api.example.com/v1/models",
    "format":      "openrouter",
    "enabled":     true,
    "api_key_env": "MYGATEWAY_API_KEY"
  }

To add an individual model from a gateway with no catalog API, edit
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

// ── Free-model detection helpers ───────────────────────────────────────────────
// Free models are either priced at $0 for both prompt & completion tokens
// (pricing may arrive as numbers or strings, and under different key names per
// gateway), or tagged with a ":free"/"-free"/"/free" name suffix.

const FREE_NAME_RE = /(?:^|[/:\-_])free$/i;

function toNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

function isZeroPricing(pricing) {
  if (!pricing || typeof pricing !== "object") return false;
  // OpenRouter/Kilo use pricing.prompt / pricing.completion;
  // AIHubMix uses pricing.input / pricing.output.
  const prompt = toNum(pricing.prompt ?? pricing.input);
  const completion = toNum(pricing.completion ?? pricing.output);
  return prompt === 0 && completion === 0;
}

function looksFreeByName(id, name) {
  return FREE_NAME_RE.test(id ?? "") || FREE_NAME_RE.test(name ?? "");
}

// free_filter strategies, selectable per source in config/sources.json
const FREE_FILTERS = {
  "zero-pricing": (m) => isZeroPricing(m.pricing ?? m.cost),
  "name-suffix": (m) => looksFreeByName(m.id, m.name),
  "zero-pricing-or-suffix": (m) =>
    isZeroPricing(m.pricing ?? m.cost) ||
    m.isFree === true ||
    looksFreeByName(m.id, m.name),
};

// ── Modality helpers ───────────────────────────────────────────────────────────
// Accepts an array or a comma-separated string (AIHubMix style); maps pdf→file
// and de-duplicates.
function normaliseModalities(input) {
  let parts = [];
  if (Array.isArray(input)) parts = input;
  else if (typeof input === "string" && input.trim())
    parts = input.split(",").map((s) => s.trim());

  const map = { pdf: "file" };
  return [...new Set(parts.map((p) => map[p] ?? p).filter(Boolean))];
}

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

// ── Misc helpers ───────────────────────────────────────────────────────────────
function titleCaseSlug(slug) {
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
}

function extractList(body) {
  // Be defensive about response shape: bare array, {data: [...]}, {models: [...]}
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.models)) return body.models;
  return null;
}

function renderSourceUrl(template, id) {
  return template?.includes("{id}") ? template.replace("{id}", id) : (template ?? "");
}

// ── Auto-fetch sources (config-driven) ─────────────────────────────────────────
// Each response "format" maps to a normalizer that turns one raw catalog entry
// into the canonical model shape. Add a new gateway layout by writing another
// normalizer and referencing it with "format" in config/sources.json.

// "openrouter" — OpenRouter-style catalog. Also matches the Kilo Gateway API,
// which now returns the identical shape (data[].pricing.{prompt,completion},
// architecture.{input,output}_modalities, top_provider, isFree flag, ...).
function normalizeOpenRouterStyle(m, source) {
  const providerSlug = m.id.split("/")[0] ?? "";
  const provider =
    source.provider || (providerSlug ? titleCaseSlug(providerSlug) : source.name);
  const allModalities = normaliseModalities([
    ...(m.architecture?.input_modalities ?? []),
    ...(m.architecture?.output_modalities ?? []),
  ]);

  return {
    id:             `${source.id_prefix ?? ""}${m.id}`,
    name:           m.name ?? m.id,
    provider,
    context_window: m.context_length ?? m.top_provider?.context_length ?? 0,
    max_output:     m.top_provider?.max_completion_tokens ?? null,
    modalities:     allModalities.length ? allModalities : ["text"],
    rate_limit:     source.rate_limit ?? getRateLimit(m.id),
    notes:          "",
    source:         renderSourceUrl(source.source_url, m.id),
    created:        m.created ?? null,
  };
}

// "aihubmix" — AIHubMix catalog. pricing.{input,output} are numbers,
// modalities are comma-separated strings, retire_stage marks deprecated rows.
function normalizeAIHubMix(m, source) {
  if (m.retire_stage && m.retire_stage !== "active") return null;

  const provider =
    source.provider || (m.vendor ? titleCaseSlug(m.vendor) : source.name);
  const allModalities = normaliseModalities(
    [m.input_modalities, m.output_modalities]
      .filter((s) => typeof s === "string")
      .join(",")
  );

  return {
    id:             `${source.id_prefix ?? ""}${m.model_id ?? m.id}`,
    name:           m.model_name ?? m.name ?? m.model_id,
    provider,
    context_window: m.context_length ?? 0,
    max_output:     m.max_output ?? null,
    modalities:     allModalities.length ? allModalities : ["text"],
    rate_limit:     source.rate_limit ?? getRateLimit(m.model_id ?? ""),
    notes:          "",
    source:         renderSourceUrl(source.source_url, m.model_id ?? m.id),
    created:        m.release_date ?? null,
  };
}

// "openai" — plain OpenAI-compatible /models listing (TokenRouter etc.).
// Usually carries no pricing, so free models are matched by name suffix and
// metadata falls back to whatever the source config provides.
function normalizeOpenAI(m, source) {
  const providerSlug = m.owned_by ?? m.id?.split("/")[0] ?? "";
  const provider =
    source.provider || (providerSlug ? titleCaseSlug(providerSlug) : source.name);
  const modalities = normaliseModalities(m.input_modalities ?? m.modalities);

  return {
    id:             `${source.id_prefix ?? ""}${m.id}`,
    name:           m.name ?? m.id,
    provider,
    context_window: m.context_length ?? m.max_context_window_tokens ?? 0,
    max_output:     m.max_output_tokens ?? null,
    modalities:     modalities.length ? modalities : ["text"],
    rate_limit:     source.rate_limit ?? getRateLimit(m.id),
    notes:          "",
    source:         renderSourceUrl(source.source_url, m.id),
    created:        m.created ?? null,
  };
}

const NORMALIZERS = {
  openrouter: normalizeOpenRouterStyle,
  aihubmix:   normalizeAIHubMix,
  openai:     normalizeOpenAI,
};

// Required fields for a source entry in config/sources.json
const REQUIRED_SOURCE_FIELDS = ["name", "url", "format"];

async function fetchWithRetry(url, headers, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`   ↳ retrying ${url} after error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  }
  throw lastErr;
}

function validateSource(s, originLabel) {
  const missing = REQUIRED_SOURCE_FIELDS.filter((f) => !s[f]);
  if (missing.length) {
    console.warn(
      `⚠️  Skipping source from ${originLabel} — missing field(s): ${missing.join(", ")}`
    );
    return false;
  }
  if (!NORMALIZERS[s.format]) {
    console.warn(
      `⚠️  Skipping source "${s.name}" — unknown format "${s.format}" (expected one of: ${Object.keys(NORMALIZERS).join(", ")})`
    );
    return false;
  }
  return true;
}

async function fetchSource(source) {
  const headers = {
    "User-Agent": "free-ai-models-tracker/1.0 (github.com/ClawLabsAI/free-ai-models)",
    Accept: "application/json",
  };

  // Optional API key (some gateways require one even to list models).
  let apiKey = null;
  if (source.api_key_env) {
    apiKey = process.env[source.api_key_env] ?? null;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    else if (source.key_required) {
      console.log(`⏭️  ${source.name}: ${source.api_key_env} not set — skipping (set it to auto-fetch this gateway)`);
      return null;
    } else {
      console.warn(`⚠️  ${source.name}: ${source.api_key_env} not set — fetching without auth`);
    }
  }

  const body = await fetchWithRetry(source.url, headers);
  const list = extractList(body);
  if (!list) throw new Error("unexpected response shape (no model list found)");

  const freeFilter =
    FREE_FILTERS[source.free_filter] ?? FREE_FILTERS["zero-pricing-or-suffix"];

  const models = list
    .filter(freeFilter)
    .map((m) => NORMALIZERS[source.format](m, source))
    .filter(Boolean);

  console.log(`✅ ${source.name}: ${models.length} free models`);
  return models;
}

async function runSources(sources) {
  // Run all sources in parallel; a failure in one is logged and skipped.
  const settled = await Promise.allSettled(sources.map((s) => fetchSource(s)));

  const results = [];
  sources.forEach((source, i) => {
    const outcome = settled[i];
    if (outcome.status === "fulfilled" && outcome.value) {
      results.push({ name: source.name, models: outcome.value });
    } else if (outcome.status === "rejected") {
      console.warn(
        `⚠️  Skipping source "${source.name}" — ${outcome.reason?.message ?? outcome.reason}`
      );
    }
  });
  return results;
}

// ── Load the sources config ────────────────────────────────────────────────────
function loadSources(configPath) {
  if (!existsSync(configPath)) {
    console.warn(`⚠️  No sources config found at ${configPath} — nothing will be auto-fetched.`);
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.warn(`⚠️  Could not parse ${configPath}: ${err.message}. No auto-fetch sources.`);
    return [];
  }

  const list = Array.isArray(raw) ? raw : raw.sources;
  if (!Array.isArray(list)) {
    console.warn(
      `⚠️  ${configPath} must be either a JSON array of sources, or an object with a "sources" array.`
    );
    return [];
  }

  return list.filter((s) => s.enabled !== false && validateSource(s, configPath));
}

// ── Cross-source dedupe ────────────────────────────────────────────────────────
// The same model id can be free on several gateways (e.g. an OpenRouter ":free"
// model is also served by Kilo Gateway). Keep one row per id: the first source
// (config order = priority) provides the base fields, later sources only
// backfill missing values and are recorded in "available_via" / "alt_sources".
function dedupeModels(perSourceResults) {
  const byId = new Map();

  for (const { name, models } of perSourceResults) {
    for (const m of models) {
      const existing = byId.get(m.id);
      if (!existing) {
        byId.set(m.id, { ...m, available_via: [name] });
      } else {
        existing.available_via = [
          ...new Set([...(existing.available_via ?? []), name]),
        ];
        if (m.source && m.source !== existing.source) {
          existing.alt_sources = [
            ...(existing.alt_sources ?? []),
            { gateway: name, url: m.source },
          ];
        }
        if (!existing.context_window && m.context_window)
          existing.context_window = m.context_window;
        if (!existing.max_output && m.max_output)
          existing.max_output = m.max_output;
        if (!existing.created && m.created) existing.created = m.created;
      }
    }
  }
  return [...byId.values()];
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

// Merge custom providers on top of the auto-fetched results: entries whose "id"
// matches an existing model override it, new ids are appended. Availability
// info collected from auto-fetch sources is preserved unless the custom entry
// specifies its own.
function mergeModels(base, custom) {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const c of custom) {
    const existing = byId.get(c.id);
    if (existing) {
      console.log(`   ↳ overriding existing entry: ${c.id}`);
    }
    byId.set(c.id, {
      available_via: existing?.available_via,
      alt_sources:   existing?.alt_sources,
      ...existing,
      ...c,
    });
  }
  return [...byId.values()];
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const sources = loadSources(SOURCES_PATH);
  console.log(
    `⏳ Fetching models from ${sources.length} source(s): ${sources.map((s) => s.name).join(", ")}…`
  );

  const perSource = await runSources(sources);
  const fetched = dedupeModels(perSource);
  const fetchedCount = perSource.reduce((n, r) => n + r.models.length, 0);
  console.log(
    `✅ ${fetchedCount} free models fetched across all sources (${fetched.length} after dedupe)`
  );

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
      ...perSource.map((r) => r.name),
      ...(customProviders.length ? ["config/custom-providers.json"] : []),
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
