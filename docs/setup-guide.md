# Setup guide — what to enter, where, and how to get it

This is a plain-language checklist for deploying a static website with atmez-deploy. Work
through it top to bottom. Each item says **what** it is, **where** to put it, and **how to
get it**. When every box is checked, the deploy runs itself.

There are two ways to deploy. Most people want **Path A**.

- **Path A — your own website repo**, auto-deploys on every push.
- **Path B — you deploy someone else's site from our repo** (they add nothing).

---

## Prerequisites checklist (gather these first)

| # | What | Where it goes | How to get it |
|---|------|---------------|---------------|
| 1 | Repo access | (granted on GitHub) | See "Grant access" below |
| 2 | `DEPLOY_SSH_KEY` | GitHub repo secret | See "Create an SSH key" below |
| 3 | `DEPLOY_HOST` | GitHub repo secret | Hostinger hPanel → SSH Access |
| 4 | `DEPLOY_USERNAME` | GitHub repo secret | Hostinger hPanel → SSH Access |
| 5 | Website folder (webroot) | in the config file | Hostinger File Manager |
| 6 | Build command + output folder | in the config file | Your project's build tool |

We verify all of these automatically before deploying. If one is missing, the run stops and
tells you exactly which one — nothing broken ever reaches your live site.

---

## Path A — deploy your own website

### 1) Grant access (so we can set it up for you)
**What:** permission for atmez-deploy to add two small files to your repo.
**Where:** GitHub → your repo → **Settings** → **Collaborators and teams** → **Add people**.
**How:** add the atmez-deploy account (or install the atmez-deploy GitHub App) with **Write**
access. You can remove it after setup.
*Prefer not to give write access?* We can instead open a **Pull Request** you simply review
and click **Merge** — that needs less access. Just ask for the PR option.

### 2) Create an SSH key (the secure connection to Hostinger)
**What:** a pair of files — a **private key** (kept secret) and a **public key** (shared with
Hostinger). Think of it as a lock (public) and its only key (private).
**How to create it** (a technical helper can do this in a terminal):
```
ssh-keygen -t ed25519 -C "atmez-deploy" -f atmez_deploy_key
```
This makes two files: `atmez_deploy_key` (private) and `atmez_deploy_key.pub` (public).
**Where each goes:**
- The **public** one (`.pub`): Hostinger hPanel → **Advanced** → **SSH Access** → add it as an
  SSH key.
- The **private** one: as a GitHub secret named `DEPLOY_SSH_KEY` (next step).

### 3) Add the secrets in GitHub
**Where:** GitHub → your repo → **Settings** → **Secrets and variables** → **Actions** →
green **New repository secret** button.
Add these, one at a time (type the **Name** exactly, paste the **Value**, click **Add secret**):

| Secret name | Value to paste | Where to find the value |
|-------------|----------------|--------------------------|
| `DEPLOY_SSH_KEY` | the entire private key file contents | the `atmez_deploy_key` file from step 2 |
| `DEPLOY_HOST` | your server address, e.g. `145.223.17.98` | Hostinger hPanel → Advanced → **SSH Access** (the "IP / Host") |
| `DEPLOY_USERNAME` | your username, e.g. `u443001285` | Hostinger hPanel → Advanced → **SSH Access** (the "Username") |

> Tip: to copy the private key contents, open the `atmez_deploy_key` file in a text editor
> and copy everything, including the `-----BEGIN...` and `-----END...` lines.

### 4) Find your website folder (webroot)
**What:** the folder on Hostinger where your site's files live and are served from.
**Where to look:** Hostinger hPanel → **Files** → **File Manager**. For an add-on domain it's
usually `domains/yourdomain.com/public_html`. For the main domain it may just be `public_html`.
**Where it goes:** this is filled into your `deploy.project.yaml` during setup (you don't edit
it by hand — the setup tool writes it from the value you provide).

### 5) Know your build details
**What:** how your site turns source code into the files that get uploaded.
- If it's a built site (React, Vue, Hugo, etc.): the **build command** (e.g. `npm ci && npm run
  build`) and the **output folder** (e.g. `dist`, `build`, `public`).
- If it's plain HTML with no build: there's no command — just the folder that holds your files.
- If it's a single-page app (uses in-app routing like React Router): note that so we publish an
  `.htaccess` that makes deep links work.
**Where it goes:** into `deploy.project.yaml` during setup.

### 6) Run setup (we do this for you)
With the above ready, we run the onboarding tool. It first **checks prerequisites** (that we
have access and the inputs are valid), then creates the two files in your repo and sets the
secrets. Example (a technical helper runs this):
```
GH_TOKEN=<access-token> node tools/onboard.mjs \
  --repo yourname/yoursite \
  --domain www.yoursite.com \
  --webroot domains/www.yoursite.com/public_html \
  --build "npm ci && npm run build" --output-dir dist [--spa] \
  --check-only          # verify everything first, change nothing
```
Remove `--check-only` to actually set it up. Add `--via-pr` to open a Pull Request instead of
writing directly.

### 7) Deploy
- **Automatic:** push your code to GitHub. It deploys itself.
- **First time (safe):** GitHub → your repo → **Actions** tab → **Deploy** → **Run workflow**.

Then open your domain in a browser. Done — every future push updates the site automatically.

---

## Path B — deploy someone else's site from our repo

The client gives you a link; you add nothing to their repo.

1. **Add them to our list.** Open `config/projects.yaml` in our repo and add an entry (copy the
   example that's already there): the repo link, their domain, and the Hostinger folder.
2. **Confirm the secret.** In **our** repo → **Settings → Secrets and variables → Actions**,
   make sure `DEPLOY_SSH_KEY` is set.
3. **Deploy.** Our repo → **Actions** tab → **Deploy from registry** → **Run workflow** → type
   the project's short name (the `id` from step 1).
   - Leave the **execute** box **unchecked** the first time (a safe practice run).
   - If it looks right, run again with **execute checked** to deploy for real.
4. Open their domain in a browser to confirm.

---

## If something's missing

Before uploading anything, an automatic check confirms your secrets, settings, and build
output. If any item is missing it stops and names exactly what to fix — so a half-configured
deploy never reaches a live site. Fix the named item and run again.
