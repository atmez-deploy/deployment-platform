# Architecture Rules

These rules guide every implementation decision. A change that violates a rule is wrong,
even if it works.

## Core rules

1. **No project-specific deployment scripts on the VPS.** The engine is generic; projects
   are configuration.
2. **No project can modify another project's resources.** Isolation at every layer
   (filesystem, Docker, network, ports, Nginx, state, user).
3. **No secrets in Git repositories.** Config references secrets by name; values live in
   the secret provider.
4. **No unnecessary root access.** Deployment identities are least-privilege and scoped to
   their own project's resources.
5. **Every resource has project + environment identity.** Names and paths are derived from
   `<project>-<environment>` consistently.
6. **The deployment engine is independent of the GitHub interface.** The engine never reads
   `GITHUB_*` context directly; callers pass a normalized input object.
7. **Public and private interfaces must both be supported** (as thin callers).
8. **Deployment must be reversible.** Every deployment type provides a rollback path
   (blue/green switch back, or symlink flip for static).
9. **Resource allocation must be automatic.** Ports and similar resources are allocated by
   the platform, not chosen by hand.
10. **Onboarding and deployment are separate operations.**

## Rules added during Step 3 (schema design)

11. **Engine is interface-agnostic via explicit boundaries.** The engine depends only on:
    - `InputContext` — normalized inputs (`project`, `environment`, `target`, `imageRef`
      or `commit`, `triggeredBy`). GitHub Actions and a future backend both map their own
      context into this object.
    - `SecretProvider` — `get(name)` abstraction. Backed by Actions-injected env vars now;
      a vault/DB later.
    - `StateStore` — deployment state + audit interface. Backed by files/VPS now; Postgres
      later.
    This is what makes Option B (backend + dashboard) an additive caller, not a rewrite.

12. **Target hosting is a driver, not a branch.** The engine resolves `target.driver` to a
    driver implementing a fixed contract (`validate/provision/publish/activate/verify/
    rollback/cleanup`). Adding a hosting provider = adding a driver.

13. **The schema encodes reality, not aspiration.** Where the platform does not control a
    concern (e.g. OS-level isolation or SSL on shared hosting), the schema states it
    explicitly (`ssl: managed_by_provider`) rather than pretending the engine is in charge.

14. **Deterministic execution.** No LLM/agent in the deployment hot path. Any AI layer
    (onboarding config drafting, failure diagnostics) is optional, sits on top, and never
    performs the live switch. Deployments must be reproducible and auditable.
