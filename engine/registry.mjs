// Registry helpers: resolve a target.ref and index a VPS's used resources.
// Pure functions over a parsed registry object (shape: schemas/registry.schema.json).

import { UnknownTargetError, UnknownPoolError, TargetKindError } from "./errors.mjs";

/**
 * Find the resource entry whose id matches ref.
 * @throws {UnknownTargetError}
 */
export function resolveTarget(registry, ref) {
  const found = (registry?.resources ?? []).find((r) => r.id === ref);
  if (!found) throw new UnknownTargetError(ref);
  return found;
}

/** Assert the resource is a vps (port/pool ops are meaningless on external hosts). */
export function assertVps(resource, op) {
  if (resource.kind !== "vps") {
    throw new TargetKindError(resource.id, resource.kind, op);
  }
  return resource;
}

/** All ports currently recorded across every hosted project on this VPS. */
export function usedPorts(vps) {
  const ports = new Set();
  for (const proj of vps.projects ?? []) {
    for (const p of proj.allocations?.ports ?? []) {
      ports.add(p.port);
    }
  }
  return ports;
}

/** All domains currently recorded on this VPS, normalized to lowercase. */
export function usedDomains(vps) {
  const domains = new Set();
  for (const proj of vps.projects ?? []) {
    for (const d of proj.allocations?.domains ?? []) {
      domains.add(String(d.domain).toLowerCase());
    }
  }
  return domains;
}

/**
 * Resolve a named port pool on a VPS.
 * @throws {UnknownPoolError}
 */
export function findPool(vps, poolName) {
  const pool = vps.port_pools?.[poolName];
  if (!pool) throw new UnknownPoolError(vps.id, poolName);
  return pool;
}
