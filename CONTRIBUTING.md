# Contributing to free-ai-models

Thanks for helping keep this list accurate and complete!

## Adding a missing free model

1. Fork this repo
2. Edit `config/custom-providers.json` — add your model to the `providers` array:

```json
{
  "id":             "provider/model-name",
  "name":           "Human Readable Name",
  "provider":       "Provider Name",
  "context_window": 128000,
  "modalities":     ["text"],
  "rate_limit":     "20 req/min",
  "notes":          "Optional: any caveats",
  "source":         "https://provider.com/docs"
}
```

3. Open a PR with title: `feat: add [Model Name] ([Provider])`

## Adding a whole gateway (auto-fetch)

If a gateway publishes its full catalog on a public `/models` endpoint, add it
to `config/sources.json` instead of listing models by hand. Each entry needs a
`name`, `url`, and a `format` matching its response shape (`openrouter`,
`aihubmix`, or `openai`). See the `_schema` block in that file for all options,
including `api_key_env` for gateways that require a key just to list models.
Only add a new `format` normalizer in `scripts/fetch-models.js` if the catalog
uses a response shape none of the existing ones cover.

## Rules

- ✅ Model must be **genuinely free** (no credit card, no trial, no waitlist)
- ✅ Must have a **public API endpoint** (not web-only)
- ✅ Include a **source URL** (docs or API reference)
- ❌ No models that require waiting lists or invite codes
- ❌ No models that are free only for the first N requests then paid

## Reporting a broken / removed model

Open an issue with the model ID and what you observed (rate limit change, 404, pricing change). We'll remove or flag it in the next update.

## Questions

Open an issue — we respond quickly.
