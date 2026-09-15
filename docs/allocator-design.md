# Resource / Port Allocator — Design Notes

The allocator is the first piece of the **deployment engine**. It is pure, deterministic,
dependency-light, and GitHub-agnostic (Rules 6, 9, 11, 14). It answers one question:

> Given a registry and a target VPS, which free port / domain should this
> project+environment+service get, and does anything collide?

It performs **no I/O of its own**: callers pass in a parsed registry object and receive a
result (or a thrown typed error). Persisting the updated registry is the caller's job.
This keeps the logic trivially unit-testable and reusable by any interface.

## Modules

```
engine/
  registry.mjs    load + index a registry; resolve target.ref
  allocator.mjs   allocatePort / allocateDomain / collision checks
  errors.mjs      typed error classes
```

## Registry helpers (`registry.mjs`)

- `resolveTarget(registry, ref)` → the resource entry with `id === ref`, or throws
  `UnknownTargetError`.
- `usedPorts(vps)` → `Set<number>` of every port recorded across all hosted projects.
- `usedDomains(vps)` → `Set<string>` of every domain recorded (lowercased).
- `findPool(vps, poolName)` → the `{start,end}` pool, or throws `UnknownPoolError`.

These read the registry shape produced by `schemas/registry.schema.json`.

## Allocation (`allocator.mjs`)

### `allocatePort(vps, poolName)` → number
- Resolves the pool. Scans `start..end` inclusive.
- Returns the **lowest** port in range not already in `usedPorts(vps)`.
  Deterministic: same registry state always yields the same next port.
- Throws `PoolExhaustedError` if every port in range is taken.

### `allocateDomain(vps, domain)` → string
- Normalizes to lowercase.
- Throws `DuplicateDomainError` if already in `usedDomains(vps)`.
- Returns the normalized domain (caller records it).

### `checkCollisions(vps, allocation)` → void
- Given a proposed `{ ports:[{port}], domains:[{domain}] }`, throws on the first
  conflict with existing allocations. Used to validate a full project's requested
  resources before writing.

## Why the allocator (not the schema) enforces uniqueness

JSON Schema validates structure and ranges per document. It cannot practically assert
"no two hosted projects on this VPS share a port" — that is a cross-record invariant.
The allocator is the single writer that guarantees it (Rule 2: project isolation).

## Error semantics (`errors.mjs`)

All typed, all extend `AllocatorError` so callers can catch broadly or narrowly:

| Error                  | When                                             |
|------------------------|--------------------------------------------------|
| `UnknownTargetError`   | `target.ref` not found in registry               |
| `UnknownPoolError`     | pool name not defined on the VPS                 |
| `PoolExhaustedError`   | no free port left in the pool's range            |
| `DuplicateDomainError` | domain already allocated on the VPS              |
| `TargetKindError`      | port/pool op attempted on an `external` resource |

## Determinism & purity guarantees

- No `Date.now()`, no randomness, no network, no filesystem inside the engine.
- Given identical inputs it produces identical outputs (Rule 14).
- The caller owns reading/writing the registry file and injecting secrets (Rule 11).
