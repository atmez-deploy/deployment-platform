# Where to get everything — plain-language reference

Before you deploy a client site, you need a few values. This page explains, for each one:
**what it is**, **where to get it**, and **how** — in plain language. No prior knowledge assumed.

There are two groups:
- **A) One-time platform secrets** — set ONCE on the `deployment-platform` repo, reused for
  every client.
- **B) Per-client inputs** — what you type into the "Onboard client site" form for each site.

---

## A) One-time platform secrets (set once)

These live on `github.com/atmez-deploy/deployment-platform` →
**Settings → Secrets and variables → Actions → New repository secret**.

### A1. `ONBOARD_TOKEN` — permission to set up client repos

**What it is:** a GitHub key that lets our onboarding button add two small files (and one
secret) into a client's repository on your behalf.

**Where/how to get it:**
1. On GitHub, click your **profile picture** (top-right) → **Settings**.
2. Scroll to the very bottom of the left menu → **Developer settings**.
3. Click **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
4. **Note:** type a name like `atmez-onboard`. **Expiration:** pick e.g. 90 days.
5. Under **Select scopes**, tick:
   - **repo** (whole section)
   - **workflow**
6. Click **Generate token** (green button at the bottom).
7. **Copy the token now** — it starts with `ghp_` and is shown only once.
8. Paste it as the secret value named `ONBOARD_TOKEN`.

**Important:** the account that creates this token must have access to the client repos
(e.g. be a collaborator). If you manage many clients, a **GitHub App** is the cleaner option
later — but a token is fine to start.

### A2. `CLIENT_DEPLOY_SSH_KEY` — the key that uploads files to the hosting

**What it is:** one half of a secure key pair ("private key"). Its matching "public key"
lives on the hosting account (Hostinger). Together they let the deploy connect and upload the
website — like a lock (public, on the server) and the only key that opens it (private, this
secret).

**Where/how to get it — two situations:**

**If you're reusing the existing hosting we already set up:**
- The private key is already on your computer. Copy it to your clipboard by running this in
  PowerShell, then paste it as the secret value:
  ```powershell
  Get-Content "$env:USERPROFILE\atmez_deploy_key" -Raw | Set-Clipboard
  ```

**If it's a brand-new hosting account:**
1. Create a new key pair (run once in PowerShell):
   ```powershell
   ssh-keygen -t ed25519 -C "atmez-deploy" -f atmez_deploy_key_new
   ```
   Press Enter twice (no passphrase). This creates two files next to each other:
   - `atmez_deploy_key_new` → the **private** key (this becomes the secret)
   - `atmez_deploy_key_new.pub` → the **public** key (goes on the hosting, see B5)
2. Copy the **private** key for the secret:
   ```powershell
   Get-Content ".\atmez_deploy_key_new" -Raw | Set-Clipboard
   ```
3. Paste it as the secret value named `CLIENT_DEPLOY_SSH_KEY`.

**One limit to know:** one `CLIENT_DEPLOY_SSH_KEY` works when all clients use the SAME hosting
account. If each client has their OWN separate hosting account/key, tell the platform team —
the button needs a small change to accept a per-client key.

---

## B) Per-client inputs (the Onboard form)

You type these into **Actions → "Onboard client site" → Run workflow**. Here's each field.

### B1. repo — the client's repository
**What:** which GitHub repo holds the site's code.
**Format:** `owner/name`, e.g. `client-co/portfolio`.
**How to get it:** open the repo on GitHub; it's in the URL
`github.com/<owner>/<name>` and at the top of the page. Ask the client to **invite you as a
collaborator with Write access** (their repo → Settings → Collaborators), or agree they'll
merge a Pull Request you open.

### B2. domain — the web address the site should load at
**What:** the address visitors type, e.g. `www.clientsite.com` (or a test address like
`something.hostingersite.com`).
**How to get it:** the client tells you. If they don't have a domain yet, the hosting
provider gives a temporary one (Hostinger shows it in hPanel under the website).

### B3. webroot — the folder on the server the site lives in
**What:** the exact folder the hosting serves the website from.
**Default:** leave blank and it uses `domains/<your-domain>/public_html` (correct for most
Hostinger add-on domains).
**How to get it (if unsure):** Hostinger hPanel → **Files → File Manager**. Navigate until you
see the folder that contains (or will contain) the site; its path is the webroot. For a
primary domain it may simply be `public_html`.

### B4. host / username / port — how to connect to the hosting
**What:** the server address, the login name, and the SSH port.
**How to get it:** Hostinger hPanel → **Advanced → SSH Access**. That page shows:
- **IP / Host** → the `host` field (e.g. `145.223.17.98`)
- **Username** → the `username` field (e.g. `u443001285`)
- **Port** → the `port` field (e.g. `65002`)
These are not secret — they're just connection details.

### B5. (new hosting only) register the public key on the server
Not a form field, but a prerequisite for a NEW hosting account: in Hostinger hPanel →
**Advanced → SSH Access**, there's a place to **add an SSH key** — paste the contents of the
`.pub` file from A2. This is what pairs with `CLIENT_DEPLOY_SSH_KEY`. (For the hosting we
already set up, this is done — skip it.)

### B6. build_command / output_dir — LEAVE BLANK
**What:** how the code is turned into the final website files.
**How to get it:** you don't need to. **Leave both blank** — the platform inspects the repo
and figures it out automatically (npm/React, Hugo, Jekyll, or plain HTML). Only fill these in
if you specifically need to override the automatic choice.

### B7. spa — tick only for app-style sites
**What:** whether it's a "single-page app" (React Router, Vue Router) where the URL changes
in the browser without reloading.
**How to get it:** if unsure, leave unticked. If the client's developer says it uses
React/Vue routing and deep links (like `/about`) must work on refresh, tick it.

### B8. check_only — tick it the FIRST time
**What:** a safe trial run. It verifies access + inputs and changes nothing.
**Use:** run once with this ticked to confirm everything's right, then run again unticked to
actually set it up.

---

## Quick summary

| Thing | Where to get it | Secret? |
| --- | --- | --- |
| `ONBOARD_TOKEN` | GitHub → Settings → Developer settings → Tokens (classic) | yes (platform repo) |
| `CLIENT_DEPLOY_SSH_KEY` | existing key file, or `ssh-keygen` for new hosting | yes (platform repo) |
| repo | the client (repo link + Write access) | no |
| domain | the client / hosting provider | no |
| webroot | Hostinger File Manager (or leave blank) | no |
| host / username / port | Hostinger hPanel → Advanced → SSH Access | no |
| public key on server | paste `.pub` in hPanel → SSH Access (new hosting only) | no |
| build_command / output_dir | leave blank — auto-detected | no |
| spa | tick for React/Vue router apps | no |

Once A) is set once and you have B) for the client, follow the steps in
`docs/manager-onboarding-guide.md` to run the onboarding button.
