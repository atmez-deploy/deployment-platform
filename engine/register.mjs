// Project registration (Step 12). Pure logic, no I/O.
// Takes a project config + an environment name + a registry, resolves the
// environment's target.ref, and produces the registry entry recording what this
// project+environment was granted (ports/domains). Returns a NEW registry object;
// the caller persists it.

import { resolveTarget, allocateBlock, portsForBlock } from "./registry.mjs";
import { allocatePort, allocateDomain, checkCollisions } from "./allocator.mjs";
import { AllocatorError } from "./errors.mjs";

export class RegistrationError extends AllocatorError {
  constructor(message, code) {
    super(message, code ?? "REGISTRATION");
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Collect the domains a project's environment wants, from service exposures.
 * @returns {{service:string, domain:string}[]}
 */
export function desiredDomains(envConfig) {
  const out = [];
  for (const [service, svc] of Object.entries(envConfig.services ?? {})) {
    if (svc.exposure?.type === "domain" && svc.exposure.domain) {
      out.push({ service, domain: svc.exposure.domain });
    }
  }
  return out;
}

/**
 * Collect the services that need a host port (exposure.type === 'port') and their
 * requested pool. For MVP static sites this is typically empty.
 * A service maps to a pool by name === service name if such a pool exists, else
 * falls back to a 'default' pool. Callers may override via svc.exposure.pool.
 * @returns {{service:string, pool:string, fixed?:number}[]}
 */
export function desiredPorts(envConfig) {
  const out = [];
  for (const [service, svc] of Object.entries(envConfig.services ?? {})) {
    if (svc.exposure?.type === "port") {
      out.push({
        service,
        pool: svc.exposure.pool ?? service,
        fixed: svc.exposure.port,
      });
    }
  }
  return out;
}

/**
 * Register a project+environment into the registry.
 * @param {object} args
 * @param {object} args.registry     parsed registry (schemas/registry.schema.json)
 * @param {object} args.projectConfig parsed project config (schemas/project.schema.json)
 * @param {string} args.environment  environment name to register
 * @returns {{registry: object, allocation: object}} new registry + the record added
 * @throws {RegistrationError|AllocatorError}
 */
export function registerProject({ registry, projectConfig, environment }) {
  const projectName = projectConfig?.project?.name;
  if (!projectName) throw new RegistrationError("project.name is required");

  const envConfig = projectConfig?.environments?.[environment];
  if (!envConfig) {
    throw new RegistrationError(`environment '${environment}' not found in project config`);
  }
  const ref = envConfig.target?.ref;
  if (!ref) {
    // External providers without a registry ref (e.g. hostinger declared inline) are
    // valid in the project schema, but registration requires a registry target.
    throw new RegistrationError(
      `environment '${environment}' target has no 'ref'; nothing to register in the registry`,
    );
  }

  const next = clone(registry);
  const target = resolveTarget(next, ref);

  // Prevent double-registration of the same project+environment.
  const existingIndex = (target.projects ?? []).findIndex(
    (p) => p.project === projectName && p.environment === environment,
  );
  if (existingIndex !== -1) {
    throw new RegistrationError(
      `${projectName}/${environment} is already registered on ${ref}`,
      "ALREADY_REGISTERED",
    );
  }

  const domains = desiredDomains(envConfig);

  // Create the record and attach it to the target up front. Allocation helpers read
  // the target's recorded allocations, so writing into this record as we go makes each
  // subsequent allocatePort/allocateDomain see the ports/domains we just granted —
  // preventing two services in the same project from colliding.
  const record = {
    project: projectName,
    environment,
    allocations: { ports: [], domains: [] },
  };
  target.projects = target.projects ?? [];
  target.projects.push(record);

  if (target.kind === "external") {
    // External host: no ports/capacity managed here. Record domains for auditing only,
    // de-duplicated against anything already on this external entry.
    for (const { service, domain } of domains) {
      record.allocations.domains.push({ service, domain: allocateDomainExternal(target, domain) });
    }
  } else if (target.port_block) {
    // BLOCK model: assign this project+env a contiguous block; blue/green ports for every
    // container service are derived from the block so projects never collide (Rule 2/9).
    // Undo the early push so allocateBlock doesn't count this record's (absent) base.
    target.projects.pop();
    const base = allocateBlock(target);
    record.block_base = base;
    target.projects.push(record);

    // Every service that runs a container needs a port pair. Use the declared service
    // order for stable index assignment.
    const serviceNames = Object.keys(envConfig.services ?? {});
    const portMap = portsForBlock(base, target.port_block.size ?? 50, serviceNames);
    for (const name of serviceNames) {
      record.allocations.ports.push({ service: name, port: portMap[name].blue, port_green: portMap[name].green });
    }
    for (const { service, domain } of domains) {
      record.allocations.domains.push({ service, domain: allocateDomain(target, domain) });
    }
  } else {
    // LEGACY pool model: fixed ports pre-validated as a batch (fail fast, no partial writes).
    checkCollisions(target, {
      ports: desiredPorts(envConfig)
        .filter((p) => typeof p.fixed === "number")
        .map((p) => ({ port: p.fixed })),
      domains: domains.map((d) => ({ domain: d.domain })),
    });

    for (const { service, pool, fixed } of desiredPorts(envConfig)) {
      const port = typeof fixed === "number" ? fixed : allocatePort(target, pool);
      record.allocations.ports.push({ service, port, pool });
    }
    for (const { service, domain } of domains) {
      record.allocations.domains.push({ service, domain: allocateDomain(target, domain) });
    }
  }

  return { registry: next, allocation: record };
}

/**
 * Domain dedupe for external targets (the allocator's allocateDomain asserts kind==='vps').
 * @throws {RegistrationError}
 */
function allocateDomainExternal(target, domain) {
  const normalized = String(domain).toLowerCase();
  const taken = new Set();
  for (const p of target.projects ?? []) {
    for (const d of p.allocations?.domains ?? []) taken.add(String(d.domain).toLowerCase());
  }
  // Count occurrences: the current record's own just-added domain would appear; guard
  // against a true duplicate by checking if it appears more than once is unnecessary
  // because we add after this call. So a single prior occurrence means a real conflict.
  if (countDomain(target, normalized) > 0) {
    throw new RegistrationError(`domain '${normalized}' already recorded on ${target.id}`, "DUPLICATE_DOMAIN");
  }
  return normalized;
}

function countDomain(target, normalized) {
  let n = 0;
  for (const p of target.projects ?? []) {
    for (const d of p.allocations?.domains ?? []) {
      if (String(d.domain).toLowerCase() === normalized) n++;
    }
  }
  return n;
}
