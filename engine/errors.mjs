// Typed errors for the deployment engine. All extend AllocatorError so callers
// can catch broadly (instanceof AllocatorError) or narrowly (instanceof PoolExhaustedError).

export class AllocatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class UnknownTargetError extends AllocatorError {
  constructor(ref) {
    super(`Unknown target ref: ${ref}`, "UNKNOWN_TARGET");
    this.ref = ref;
  }
}

export class UnknownPoolError extends AllocatorError {
  constructor(vpsId, pool) {
    super(`Unknown port pool '${pool}' on ${vpsId}`, "UNKNOWN_POOL");
    this.vpsId = vpsId;
    this.pool = pool;
  }
}

export class PoolExhaustedError extends AllocatorError {
  constructor(vpsId, pool, start, end) {
    super(`Port pool '${pool}' on ${vpsId} is exhausted (range ${start}-${end})`, "POOL_EXHAUSTED");
    this.vpsId = vpsId;
    this.pool = pool;
    this.start = start;
    this.end = end;
  }
}

export class DuplicateDomainError extends AllocatorError {
  constructor(vpsId, domain) {
    super(`Domain '${domain}' is already allocated on ${vpsId}`, "DUPLICATE_DOMAIN");
    this.vpsId = vpsId;
    this.domain = domain;
  }
}

export class DuplicatePortError extends AllocatorError {
  constructor(vpsId, port) {
    super(`Port ${port} is already allocated on ${vpsId}`, "DUPLICATE_PORT");
    this.vpsId = vpsId;
    this.port = port;
  }
}

export class TargetKindError extends AllocatorError {
  constructor(ref, kind, op) {
    super(`Operation '${op}' is not valid on ${kind} target '${ref}'`, "TARGET_KIND");
    this.ref = ref;
    this.kind = kind;
    this.op = op;
  }
}
