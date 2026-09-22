# Manager guide — onboard a new client's static site

**Situation:** a client gave you a new GitHub repo with a static website in it (plain HTML, or
a built site like React/Vue/Hugo). You have access to that repo. Your job is to get it
deploying automatically. This guide tells you exactly what to do and what to ask the platform
owner (referred to below as "the platform team") for.

You do NOT write any deployment code. The platform team runs one onboarding step that adds two
small files to the client repo; after that, the repo deploys itself on every push.

---

## Step 1 — Gather information about the client repo

Look at the repo and note these. You'll pass them to the platform team.

| What to find | Where to look | Example |
|--------------|---------------|---------|
| Repo name | the GitHub URL | `client-org/marketing-site` |
| Branch to deploy | usually `main` | `main` |
| Is there a build step? | look for `package.json` with a `build` script | yes / no |
| Build command | `package.json` "scripts" → build | `npm ci && npm run build` |
| Output folder | where the build writes files | `dist`, `build`, `out`, `public` |
| Plain HTML (no build)? | files served as-is, no framework | folder that holds `index.html` |
| Single-page app (SPA)? | uses in-app routing (React Router etc.) | yes / no |

If you're unsure about build details, that's fine — the platform can auto-detect the output
folder, and you can confirm with the client's developer.

---

## Step 2 — Decide where it should be hosted

The site publishes to a hosting account (e.g. Hostinger). You need the **target**:

| What | Example |
|------|---------|
| The domain the site should serve on | `www.clientsite.com` |
| The hosting account's web folder (webroot) | `domains/www.clientsite.com/public_html` |

If the client is using their own hosting, ask them (or the platform team) for these. If the
platform team provides the hosting, ask them.

---

## Step 3 — Ask the platform team for the prerequisites

These are the things only the platform team can provide or do. Send them this checklist:

1. **Confirm hosting access is set up.** The platform team must have the site's SSH access
   configured on the hosting account (the public key added in the host's panel). Ask:
   *"Is SSH access set up on the hosting account for this site, and do you have the private
   key ready to install as the repo secret?"*

2. **The deploy secret value** (`DEPLOY_SSH_KEY`). This is the private SSH key that lets the
   deploy connect to the hosting account. The platform team gives you this value to paste into
   the client repo's secrets (Step 4). It is sensitive — get it over a secure channel, not
   email/chat.

3. **Grant onboarding access, OR agree on a Pull Request.** The onboarding step needs to write
   two files into the client repo. Either:
   - add the platform team's account (or GitHub App) to the client repo with **Write** access
     for a few minutes, **or**
   - ask them to onboard via a **Pull Request** you then merge (needs less access).

4. **Run onboarding.** Give the platform team the details from Steps 1–2 (repo name, branch,
   domain, webroot, build command + output folder, SPA yes/no). They run the onboarding tool,
   which:
   - adds `deploy.project.yaml` (where/how to deploy) to the repo,
   - adds `.github/workflows/deploy.yml` (the CI/CD) to the repo.

**Summary of what to ask the platform team for:**
> "Please: (1) confirm SSH access is set up on the hosting account, (2) send me the
> `DEPLOY_SSH_KEY` value securely, (3) tell me whether to grant you Write access or expect a
> PR, and (4) run onboarding for repo `<repo>`, branch `<branch>`, domain `<domain>`, webroot
> `<webroot>`, build `<command>` → `<output folder>` (SPA: yes/no)."

---

## Step 4 — Add the deploy secret to the client repo

Once the platform team sends you the `DEPLOY_SSH_KEY` value:

1. Open the client repo on GitHub.
2. Click **Settings** → **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. **Name:** `DEPLOY_SSH_KEY`
5. **Value:** paste the private key the platform team gave you (include the
   `-----BEGIN...` and `-----END...` lines).
6. Click **Add secret**.

(That's the only secret needed for a standard SSH deploy. If the platform team says the
hosting uses FTP instead, they'll tell you to add `FTP_PASSWORD` instead.)

---

## Step 5 — First deploy

After onboarding (Step 3) and the secret (Step 4) are done:

- The two files were added to the repo, which already triggers a deploy run, **or**
- Trigger it yourself: client repo → **Actions** tab → **Deploy** → **Run workflow** → main.

Watch the run in the **Actions** tab. The steps are:
1. Checkout site repo
2. Checkout deployment platform (the shared engine)
3. Build (runs the client's build command)
4. **Preflight gate** (verifies config + inputs + the secret)
5. Deploy (publishes to the live site)

When it shows a green check, open the site's domain in a browser (Ctrl + F5 to skip cache) —
the site is live.

If the **Preflight gate** step fails, it prints exactly what's missing (e.g. a secret not set,
or a build folder not found). Fix that item and re-run. Nothing is published unless the gate
passes, so the live site is never left broken.

---

## Step 6 — Ongoing (nothing to do)

From now on, **every push to the client repo's branch deploys automatically.** The developer
just pushes code; the site updates. You don't run anything per deploy.

---

## Quick reference — what YOU do vs. what the PLATFORM TEAM does

| You (the manager) | The platform team |
|-------------------|-------------------|
| Gather repo + target details (Steps 1–2) | Set up SSH access on the hosting account |
| Grant access or merge the onboarding PR | Provide the `DEPLOY_SSH_KEY` value |
| Add the `DEPLOY_SSH_KEY` secret (Step 4) | Run onboarding (adds the 2 files) |
| Trigger/verify the first deploy (Step 5) | (available if the preflight flags an issue) |

---

## Troubleshooting

- **"Checkout deployment platform" fails:** the shared engine repo isn't accessible. Ask the
  platform team — they either make it accessible to the org or give you a `PLATFORM_TOKEN`
  secret to add.
- **Preflight gate fails on a secret:** the `DEPLOY_SSH_KEY` secret isn't set (or misnamed).
  Re-check Step 4 — the name must be exactly `DEPLOY_SSH_KEY`.
- **Preflight gate fails on the build folder:** the build didn't produce the expected folder.
  Confirm the build command and output folder with the client's developer, and tell the
  platform team to set it explicitly.
- **Deep links 404 on a React/Vue app:** it's a single-page app — tell the platform team to
  enable SPA mode so an `.htaccess` is published. (Confirm "SPA: yes" in Step 3.)
