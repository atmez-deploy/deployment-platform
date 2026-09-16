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

import { BlockExhaustedError } from "./errors.mjs";

// --- Port-block allocation --------------------------------------------------
// A VPS carries a `port_block` config: { start, end, size } (size default 50).
// Each project+environment is assigned a contiguous block of `size` ports. Within
// a block, blue services use base + index, green services use base + size/2 + index.
// This guarantees: (a) projects never overlap each other's ports, and (b) blue/green
// of the same project never conflict. See docs.

const DEFAULT_BLOCK_SIZE = 50;

export function blockConfig(vps) {
  const b = vps.port_block ?? {};
  return {
    start: b.start ?? 5000,
    end: b.end ?? 9000,
    size: b.size ?? DEFAULT_BLOCK_SIZE,
  };
}

/** The set of block base ports already assigned to projects on this VPS. */
export function usedBlockBases(vps) {
  const bases = new Set();
  for (const p of vps.projects ?? []) {
    if (Number.isInteger(p.block_base)) bases.add(p.block_base);
  }
  return bases;
}

/**
 * Find the lowest free block base on a VPS: a multiple-of-size offset from start whose
 * range [base, base+size) does not overlap any already-assigned block.
 * @throws {BlockExhaustedError}
 */
export function allocateBlock(vps) {
  assertVps(vps, "allocateBlock");
  const { start, end, size } = blockConfig(vps);
  const used = usedBlockBases(vps);
  for (let base = start; base + size - 1 <= end; base += size) {
    if (!used.has(base)) return base;
  }
  throw new BlockExhaustedError(vps.id, start, end, size);
}

/**
 * Given a block base + size and an ordered list of service names, compute per-service
 * blue/green host ports. Deterministic and collision-free within the block.
 * @returns {Record<string,{blue:number,green:number}>}
 */
export function portsForBlock(base, size, serviceNames) {
  const half = Math.floor(size / 2);
  if (serviceNames.length > half) {
    throw new Error(`too many services (${serviceNames.length}) for half-block of ${half}`);
  }
  const out = {};
  serviceNames.forEach((name, i) => {
    out[name] = { blue: base + i, green: base + half + i };
  });
  return out;
}
