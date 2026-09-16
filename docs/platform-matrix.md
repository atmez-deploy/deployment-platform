# Platform Matrix — What Deploys Where

Use this to pick the right target for a project. The rule of thumb:

> **Produces static files → static hosting works. Needs a running server process → VPS.**

## App type × target

| App type | hostinger-ssh | hostinger-ftp | cpanel | vps (docker) |
|---|:---:|:---:|:---:|:---:|
| React/Vue/Angular/Svelte SPA (build → files) | ✅ | ✅ | ✅ | ✅ |
| Static generators — Hugo, Jekyll, Astro, 11ty | ✅ | ✅ | ✅ | ✅ |
| Next.js / Nuxt **static export** | ✅ | ✅ | ✅ | ✅ |
| Plain HTML/CSS/JS (no build) | ✅ | ✅ | ✅ | ✅ |
| Next.js / Nuxt **SSR** (needs Node server) | ❌ | ❌ | ❌ | ✅ |
| Node / Python / Go / Java / Rust backend | ❌ | ❌ | ❌ | ✅ |
| PHP / Laravel / WordPress | ⚠️¹ | ⚠️¹ | ✅² | ✅ |
| Microservices (multiple services) | ❌ | ❌ | ❌ | ✅ |
| Needs a database | ❌ | ❌ | ⚠️³ | ✅ |

¹ PHP runs on Hostinger shared (it has a PHP runtime); the file-upload drivers place the
files, but there's no PHP-specific step (composer/.htaccess/migrations) yet.
² cPanel hosts run PHP + MySQL; the upload works and the host executes PHP.
³ cPanel provides MySQL, but the platform doesn't manage cPanel DBs yet (manual for now).

## Driver ↔ platform ↔ command

| Platform id | Driver | CLI command | Full auto-provision? |
|---|---|---|---|
| `vps` | docker-vps | `deploy-service` / `rollback-service` | ✅ (user/dir/port/nginx/SSL) |
| `hostinger-ssh` | static-hostinger (ssh) | `deploy` / `rollback` | ❌ (FTP/subdomain manual) |
| `hostinger-ftp` | static-hostinger (ftps) | `deploy` | ❌ (FTP/subdomain manual) |
| `cpanel` | cpanel | `deploy-cpanel` | ✅ (subdomain + FTP via UAPI) |

Static-on-VPS also exists (the `vps` driver with `deployment.type: static`) — releases +
symlink swap + Certbot on your own box.

## Capabilities by target

| Capability | hostinger-ssh | hostinger-ftp | cpanel | vps |
|---|:---:|:---:|:---:|:---:|
| Atomic release + instant rollback | ✅ (symlink) | ❌ (redeploy) | ❌ (redeploy) | ✅ (blue/green) |
| SSL | provider (hPanel) | provider (hPanel) | provider (AutoSSL) | Certbot (platform) |
| Auto-provision subdomain/account | ❌ | ❌ | ✅ (UAPI) | n/a |
| Multiple services / microservices | ❌ | ❌ | ❌ | ✅ |
| Language of the app | any (static) | any (static) | any static + PHP | **any** (image) |

## Choosing quickly

- **Cheap static site, host already set up manually** → `hostinger-ssh` (best) or
  `hostinger-ftp` (cheapest plans).
- **Static site, want automated onboarding** → `cpanel` (creates subdomain + FTP for you),
  or a VPS.
- **Any backend, microservices, SSR, or you want zero-downtime + SSL automation** → `vps`.
- **Many static sites at scale** → any static target + the onboarding generator
  (see [onboarding.md](onboarding.md)).
