# Language Independence

The platform does not care what language or framework a project uses. This is by design.

## VPS / cloud services (Docker) — image-based

The engine deploys a **container image**. Whatever the app is written in — Node, Python,
Go, Java, PHP, Rust, .NET — if the project's own CI builds it into an image and pushes it
to a registry, the engine deploys it identically. The engine never inspects the language.

What a service must provide (all language-agnostic):
- An **image** reference (built by the app repo's CI).
- A **container_port** it listens on (default 3000 for a service named `backend`, else 80;
  set `container_port` to be explicit).
- A **health path** (default `/api/health` for backend, `/` otherwise; configurable).

Migrations, if any, are just a shell command run inside the container (`database.migrate_command`).

## Static sites — build is whatever you declare

Static deployment runs the project's own `build.command` verbatim. It is not tied to npm:

| Project              | build.command                     | output_dir |
|----------------------|-----------------------------------|-----------|
| Vite / CRA / Next export | `npm ci && npm run build`     | `dist`    |
| Hugo (Go)            | `hugo --minify`                   | `public`  |
| Jekyll (Ruby)        | `bundle exec jekyll build`        | `_site`   |
| Plain HTML (no build)| *(omit command)*                  | `public`  |
| Anything with a Make | `make site`                       | `out`     |

Two knobs make this fully general:
- **Omit `build.command`** → no build; the files in `output_dir` are published as-is.
- **`build.image`** → run the build inside a container (e.g. `golang:1.22`, `ruby:3.3`,
  `klakegg/hugo`) so the toolchain is independent of the CI runner. Without it, the command
  runs on the runner directly.

## What is NOT the platform's job

The platform deploys; it does not *build your app for you* by guessing. Each project
declares how it's built (a command, or an image, or nothing). That declaration is the only
language-specific thing, and it lives in the project's own config — never hardcoded in the
engine. This keeps the engine generic (architecture Rule 1) while supporting any stack.
