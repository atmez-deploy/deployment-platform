# Manager walkthrough — verify the deployment platform works

This guide lets you confirm, by yourself, that the atmez-deploy platform deploys a real
client repository end to end. It uses a throwaway client repo (`atmez-deploy/testing`) and a
throwaway website, so nothing real is touched.

**What you're verifying:** a separate client repository, containing only its own code plus
two small atmez-deploy files, builds itself and publishes to a live URL automatically — with
a safety check that blocks the deploy if anything is misconfigured.

**Time needed:** about 5 minutes.

---

## The setup at a glance

- **Engine repo:** `atmez-deploy/deployment-platform` — the deployment logic (built once, shared).
- **Client repo:** `atmez-deploy/testing` — a throwaway site that behaves like a real customer repo.
- **Live URL:** https://mediumslateblue-mantis-944780.hostingersite.com (a temporary Hostinger site).

The client repo holds only:
- `build.mjs` + `src/index.html` — the "app" (a tiny site with a build step).
- `deploy.project.yaml` — where/how to deploy (added by atmez-deploy onboarding).
- `.github/workflows/deploy.yml` — the CI/CD that runs on every push (added by onboarding).

The client repo added no deployment logic of its own — it just calls the shared engine.

---

## A) See that it is already live (30 seconds)

1. Open a browser and go to:
   **https://mediumslateblue-mantis-944780.hostingersite.com**
2. Press **Ctrl + F5** (hard refresh, to skip any cached copy).
3. You should see a dark card: **"✅ Deployed from a client repo by atmez-deploy"** with a
   build-stamp line (a timestamp + commit id).

That page was produced by the client repo's own pipeline — not uploaded by hand.

---

## B) Trigger a fresh deploy yourself and watch it run (3–4 minutes)

This proves it runs on demand, not just once.

1. Go to the client repo's Actions page:
   **https://github.com/atmez-deploy/testing/actions**
2. In the left sidebar, click the **"Deploy"** workflow.
3. Click the **"Run workflow"** button (top right), keep the branch as **main**, and click the
   green **"Run workflow"**.
4. A new run appears. Click into it and watch the steps complete in order:
   - **Checkout site repo** — pulls the client's code
   - **Checkout deployment platform** — pulls the shared engine
   - **Build** — runs the site's build (`node build.mjs` → `dist/`)
   - **Preflight gate** — verifies config + inputs + the required secret
   - **Deploy** — publishes to the live site over SSH
5. When the run shows a green check (**success**), reload the live URL (Ctrl + F5). The
   **build stamp on the page will have updated** to the new run's time/commit — proof this
   deploy just republished the site.

---

## C) See the safety check block a bad deploy (optional, 2 minutes)

This shows the platform refuses to deploy a misconfigured project instead of failing silently.

1. In the client repo, open **`deploy.project.yaml`** (use GitHub's web editor: open the file
   and click the pencil icon).
2. Temporarily break it — for example, change the `webroot:` line value to an empty string,
   or delete the `build:` section. Commit the change to `main`.
3. Go to **Actions** — a new run starts automatically on that commit.
4. Open the run: the **Preflight gate** step fails with a clear message naming what's wrong,
   and the **Deploy** step is skipped. The live site is left untouched.
5. **Undo your change** (revert the file to its previous content and commit) so the repo is
   healthy again. The next run will deploy normally.

This is the guarantee: a broken or incomplete setup never reaches the live site.

---

## What this demonstrates

- A client repo deploys itself on every push (and on demand) using only two small files.
- The deployment logic lives in one shared engine, maintained in one place.
- Each deploy builds the site fresh and publishes it to a live URL.
- A preflight gate validates configuration, inputs, and secrets, and blocks bad deploys.
- No manual file uploads, no server login by the developer — it's fully automated.

---

## Notes for the reviewer

- This is a **static-site** deployment to shared hosting (Hostinger) over SSH. The platform
  also supports containerized **backend** deployments to a VPS (build image → push to
  registry → blue/green deploy on the server); that path needs a live VPS to demo and is
  documented separately (`docs/backend-lifecycle.md`).
- The `testing` repo and its live site are **throwaway** and safe to delete after review.
- The engine repo is currently public so the client repo can pull it with no token. It can be
  made private later; client repos then add one read-only `PLATFORM_TOKEN` secret (already
  supported by the workflow).
