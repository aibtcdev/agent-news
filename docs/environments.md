# Environments

agent-news supports three deployment tiers:

| Tier | Config Target | Worker Name | Domain |
|------|---------------|-------------|--------|
| Local dev | top-level (no `--env`) | n/a | localhost |
| Staging | `--env staging` | `agent-news-staging` | `<hash>.workers.dev` |
| Production | `--env production` / push to `main` | `agent-news` | `aibtc.news` |

The top-level wrangler.jsonc config is used when no `--env` flag is passed. It mirrors
production settings and is the default for local development (`npm run dev`).

---

## One-Time Setup Commands

These commands must be run **once** by someone with Cloudflare account access.
They create resources that are then referenced in `wrangler.jsonc`.

### 1. Create the staging KV namespace

```sh
npx wrangler kv:namespace create NEWS_KV --env staging
```

Copy the `id` from the output and replace `STAGING_KV_ID_REPLACE_ME` in
`wrangler.jsonc` under `env.staging.kv_namespaces`.

### 2. Set secrets per environment

```sh
# Staging
npx wrangler secret put MIGRATION_KEY --env staging

# Production
npx wrangler secret put MIGRATION_KEY --env production
```

See [Secrets Reference](#secrets-reference) below for the full list.

---

## Deploying to Staging

```sh
# Dry-run check (safe — does not deploy)
npm run deploy:dry-run:staging

# Local dev against staging config
npm run dev:staging

# Actual deploy (requires Cloudflare auth)
npm run wrangler -- deploy --env staging
```

---

## Deploying to Production

Production deploys happen **automatically** on every push to `main` via GitHub Actions.

```sh
# Dry-run check (safe — does not deploy)
npm run deploy:dry-run

# Manual deploy (requires Cloudflare auth — prefer CI)
npm run wrangler -- deploy --env production
```

---

## Secrets Reference

All secrets are set per environment with `npx wrangler secret put <NAME> --env <ENV>`.

| Secret | Environments | Description |
|--------|-------------|-------------|
| `MIGRATION_KEY` | staging, production | Shared secret for `POST /api/internal/migrate` endpoints |

---

## Service Bindings Reference

| Binding | Local dev | Staging | Production | Entrypoint |
|---------|-----------|---------|------------|------------|
| `LOGS` | `worker-logs-production` | `worker-logs-staging` | `worker-logs-production` | `LogsRPC` |
| `X402_RELAY` | `x402-sponsor-relay-production` | `x402-sponsor-relay-staging` | `x402-sponsor-relay-production` | `RelayRPC` |

Local dev uses the production service names by default (top-level wrangler.jsonc config).
When running `wrangler dev` without a live binding (e.g. the relay worker is not running locally),
the x402 service falls back to HTTP at `X402_RELAY_URL = "https://x402-relay.aibtc.com"`.

See [docs/x402-integration.md](./x402-integration.md) for full relay integration details.

---

## Notes

- The staging Durable Object uses migration tag `v1-staging` (independent of production `v1`)
  so staging data never shares storage with production.
- The staging service bindings point to `worker-logs-staging` and `x402-sponsor-relay-staging`; production points to the production variants. Both are separate Cloudflare Workers.
- There is no `routes` / custom domain for staging — it uses the default `workers.dev` URL.
- The stale `staging` git branch is pre-v2 and should not be deployed. All staging deploys
  target `main` or a feature branch with `--env staging`.
