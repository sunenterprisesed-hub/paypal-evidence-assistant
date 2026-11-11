# Deployment options

Researched 2026-11-09. Prices below come from third-party comparisons (sources
at the bottom) and were NOT verified against each provider's own pricing page
- confirm before committing. No hosting account has been created or changed;
any paid option needs the owner's explicit approval first.

## What this app needs

- Node.js >= 22.5, long-running process (not serverless functions)
- Persistent disk for `DATA_DIR` (SQLite database + uploaded evidence files)
- TLS termination (the app serves plain HTTP; terminate at the proxy/platform)
- Environment-variable secrets (all config is env-based already)

## Options compared (always-on ~0.5 vCPU / 512 MB, monthly)

| Provider | Approx. cost | Notes for this app |
| --- | --- | --- |
| Fly.io | ~$3.69 (shared-cpu-1x 512MB, iad/ewr) + egress ($0.12/GB for India) | Cheapest managed always-on found. Trial only (2h runtime or 7 days) for new orgs, then paid. Volumes for DATA_DIR at $0.15/GB-month. |
| DigitalOcean App Platform | ~$5 (1 vCPU / 512 MiB, 50 GiB transfer included) | Simple bill; paid containers always-on. India-region availability to confirm. |
| Render | $7 (Starter 0.5 CPU / 512 MB) | Free tier exists (750 h/month) BUT sleeps after 15 min idle - bad for a live demo with judges. Persistent disks $0.25/GB-month. |
| Railway | Hobby $5 incl. $5 usage; metered ~$15 at this size | Usage-based billing can exceed the plan price - not a spending cap. |
| VPS + Coolify (Hetzner CX23) | ~$6.49 (2 vCPU / 4 GB) | Most control; you own patching, TLS (Caddy/Certbot), firewall, backups. |

For the hackathon demo the practical shortlist is Fly.io (~$4-5) or
DigitalOcean (~$5): always-on, persistent disk, env-var config, minimal ops.
Render's free tier is unsuitable for judging because of the 15-minute sleep.

## Secret handling (any option)

- Set `APP_ENV=production`, a random 64-char `SESSION_SECRET`, and a strong
  `ADMIN_PASSWORD` through the platform's env/secret manager - never in the
  repo, never in chat.
- `PAYPAL_CLIENT_SECRET` and `AI_API_KEY` go in the same secret store.
- Keep `SUBMISSIONS_ENABLED=false` until the demo script explicitly needs it.
- `DATA_DIR` must live on the platform's persistent volume, not the
  ephemeral container filesystem, or cases/uploads vanish on redeploy.

## Production checklist

1. `APP_ENV=production`, strong `SESSION_SECRET` + `ADMIN_PASSWORD` set
2. TLS terminated by the platform (all listed do this on their app domains)
3. Persistent volume mounted at `DATA_DIR`
4. `npm start` as the run command; Node 22.x pinned
5. Confirm the app's readiness by loading `/login` and checking the badges

## Sources

- https://c17.io/compare/app-hosting (per-provider cost table, Fly/Render/Railway/DO/Hetzner figures)
- https://www.itechguides.com/best-node-js-hosting-options-in-2026-compare-render-railway-fly-io-and-more/ (Render free-tier 750h + 15-min sleep, Railway/Railway metered caution, Fly trial limits)
