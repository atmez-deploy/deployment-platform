# VPS / Resource Registry — Design Notes

Source of truth: `schemas/registry.schema.json` (JSON Schema 2020-12).
Human-authored instance: `config/registry.example.yaml` (real registries live in the
platform's own config, never inside a client repo).

## Purpose

The registry is the platform's inventory of infrastructure. A project config says
`target: { driver: vps, ref: vps-01 }` — the registry is what `vps-01` resolves to:
its address, capacity, the port pools it allocates from, and which projects it hosts.

```
project config (target.ref: vps-01)
        │  resolve
        ▼
registry entry "vps-01"  ──►  connection + capacity + port pools + hosted projects
```

This keeps the project config small and portable, and centralizes the "what exists"
knowledge the resource manager needs for allocation (Rule 9).

## What the registry is NOT

- **Not a place for secrets** (Rule 3). It holds the *username* and a `ssh_key_ref`
  (a name), never a key. The `SecretProvider` resolves the name at runtime (Rule 11).
- **Not GitHub-specific** (Rule 6). It is plain data the engine reads; any caller can
  supply it.
- **Not per-project.** One registry describes shared infrastructure; isolation between
  projects is enforced by the allocations recorded here (Rule 2).

## A VPS entry

```
id            stable identity, matches target.ref (e.g. vps-01)   [Rule 5]
provider      informational (hetzner, contabo, aws-ec2, ...)
connection    host, port, username, ssh_key_ref (name only)       [Rule 3]
capacity      cpu / memory_mb / storage_gb — informational limits
port_pools    named ranges the allocator draws from               [Rule 9]
projects      which project+environment pairs live here, and the
              resources allocated to each (ports, domains)         [Rule 2]
```

### Port pools (Rule 9 — automatic allocation)

Ports are allocated by the platform, never hand-picked. A VPS declares named pools by
service class; the allocator picks the next free port from the right pool and records it:

```
port_pools:
  backend:  { start: 5000, end: 5099 }
  web:      { start: 8100, end: 8199 }
```

Where possible we avoid host ports entirely and let Nginx route to containers over the
Docker network — but for cases that need a host port, the pool is the source of free
ports and the `projects[].allocations` records what has been taken, so two projects can
never collide.

### Recorded allocations (Rule 2 — isolation)

Each hosted project+environment records what it was granted. This is how the platform
guarantees one project can't take another's port/domain:

```
projects:
  - project: example-app
    environment: staging
    allocations:
      ports:
        - { service: backend, port: 5000, pool: backend }
      domains:
        - { service: backend, domain: api.staging.example.com }
        - { service: web,     domain: staging.example.com }
```

The allocator's contract:
- A new allocation must draw a port from within the named pool's range.
- A port may appear at most once per VPS (uniqueness enforced by the resource manager;
  the schema enforces shape, the manager enforces cross-entry uniqueness at write time).
- A domain may appear at most once per VPS.

> Note on responsibility split: JSON Schema validates *structure and ranges*. It cannot
> practically prove "no two allocations share a port across all projects" — that
> cross-record invariant is enforced by the resource-manager code (a later step) and by
> a dedicated lint check. The schema still catches the common mistakes (out-of-range
> port, duplicate domain within one project, malformed entries).

## Relationship to external targets (hostinger, netlify, s3_cdn)

The registry is primarily for `vps` targets, where the platform owns allocation. External
providers manage their own resources, so they do not need port pools. For completeness the
registry can list them as `external` entries (id + provider + note) so `target.ref` can
resolve for auditing, but no ports/capacity are tracked (Rule 13 — encode reality).

## Files

```
schemas/registry.schema.json   # the schema (source of truth)
config/registry.example.yaml   # example instance (vps-01 + external entries)
```

---

## Port-block allocation (per-project, collision-free)

A VPS can use the **block model** instead of named pools. Config:

```yaml
port_block:
  start: 5000
  end: 8000
  size: 50   # ports per project
```

Each project+environment is assigned a contiguous block of `size` ports, recorded as
`block_base` on its registry entry. Within a block:

```
blue  service_i  = block_base + i
green service_i  = block_base + size/2 + i
```

Guarantees:
- **Projects never collide**: blocks don't overlap (allocator picks the lowest free base).
- **Blue/green never collide**: they live in the lower/upper halves of the same block.
- Around 25 services max per color per project (size/2), which is ample.

The allocator (`allocateBlock`) scans assigned bases and returns the lowest free one; the
resource manager should still verify against actually-listening ports on the server before
first use. The legacy `port_pools` model remains supported for single-port services.

---

## Roadmap: provider drivers for automated onboarding

Hostinger **shared** hosting has no API to create FTP accounts / subdomains, so those steps
stay manual there. For fully-automated provisioning of shared hosting, a **cPanel/WHM
driver** is the path: cPanel's UAPI/WHM API can create FTP accounts, subdomains, and
databases programmatically. A future `cpanel` target driver would let cPanel-based hosts
get the same one-click onboarding that Hostinger shared cannot. VPS targets already support
full automation (users, dirs, ports, nginx, Certbot).
