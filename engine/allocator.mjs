// Deterministic resource allocator. Pure logic, no I/O.
// Given a VPS entry (from the registry) it picks free ports/domains and detects
// collisions. Callers persist the updated registry themselves.

import { assertVps, usedPorts, usedDomains, findPool } from "./registry.mjs";
import { PoolExhaustedError, DuplicateDomainError, DuplicatePortError } from "./errors.mjs";

/**
 * Allocate the lowest free port from a named pool on a VPS.
 * Deterministic: identical registry state yields the same port.
 * @param {object} vps  a vps resource entry
 * @param {string} poolName
 * @returns {number}
 * @throws {UnknownPoolError|PoolExhaustedError|TargetKindError}
 */
export function allocatePort(vps, poolName) {
  assertVps(vps, "allocatePort");
  const pool = findPool(vps, poolName);
  const taken = usedPorts(vps);
  for (let port = pool.start; port <= pool.end; port++) {
    if (!taken.has(port)) return port;
  }
  throw new PoolExhaustedError(vps.id, poolName, pool.start, pool.end);
}

/**
 * Validate that a specific port is free on a VPS (used when a fixed port is requested).
 * @throws {DuplicatePortError|TargetKindError}
 */
export function assertPortFree(vps, port) {
  assertVps(vps, "assertPortFree");
  if (usedPorts(vps).has(port)) throw new DuplicatePortError(vps.id, port);
  return port;
}

/**
 * Normalize and validate a domain is free on a VPS.
 * @returns {string} normalized (lowercase) domain
 * @throws {DuplicateDomainError|TargetKindError}
 */
export function allocateDomain(vps, domain) {
  assertVps(vps, "allocateDomain");
  const normalized = String(domain).toLowerCase();
  if (usedDomains(vps).has(normalized)) throw new DuplicateDomainError(vps.id, normalized);
  return normalized;
}

/**
 * Validate a full proposed allocation against existing state AND against itself
 * (so a single request can't ask for the same port/domain twice).
 * @param {object} vps
 * @param {{ports?: {port:number}[], domains?: {domain:string}[]}} allocation
 * @throws {DuplicatePortError|DuplicateDomainError|TargetKindError}
 */
export function checkCollisions(vps, allocation) {
  assertVps(vps, "checkCollisions");
  const takenPorts = usedPorts(vps);
  const takenDomains = usedDomains(vps);
  const seenPorts = new Set();
  const seenDomains = new Set();

  for (const { port } of allocation.ports ?? []) {
    if (takenPorts.has(port) || seenPorts.has(port)) throw new DuplicatePortError(vps.id, port);
    seenPorts.add(port);
  }
  for (const { domain } of allocation.domains ?? []) {
    const d = String(domain).toLowerCase();
    if (takenDomains.has(d) || seenDomains.has(d)) throw new DuplicateDomainError(vps.id, d);
    seenDomains.add(d);
  }
}
