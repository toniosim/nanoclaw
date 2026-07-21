/**
 * Docker-ops allowlist — the set of compose projects an agent may act on.
 *
 * Stored OUTSIDE the project root (`~/.config/nanoclaw/docker-allowlist.json`),
 * exactly like the mount allowlist: containers mount the workspace and their
 * two session DBs, never `~/.config/nanoclaw`, so an agent has no write path
 * to the list that bounds it. Growing the list is an operator action on the
 * host (see the /manage-docker-ops skill) — there is deliberately no ncl verb
 * and no MCP tool that adds an entry, with or without approval.
 *
 * Two independent bounds come out of this file:
 *   - WHICH projects exist at all (an unlisted name is rejected before the
 *     guard is ever consulted — "spin up something new" is unrepresentable),
 *   - WHICH verbs each project permits (`allow`), optionally narrowed to
 *     specific agent groups (`agentGroups`).
 *
 * Shape:
 *   {
 *     "services": [
 *       {
 *         "name": "sonarr",
 *         "composeFile": "/home/me/services/sonarr/docker-compose.yml",
 *         "service": "sonarr",            // optional, defaults to name
 *         "allow": ["status", "logs", "restart", "update"],
 *         "agentGroups": ["<agent-group-id>"],  // optional; omitted = any group
 *         "description": "TV automation"
 *       }
 *     ]
 *   }
 */
import fs from 'fs';
import path from 'path';

import { DOCKER_ALLOWLIST_PATH } from '../../config.js';
import { log } from '../../log.js';

/** Every verb the ops surface can express. There is no "run arbitrary image". */
export const DOCKER_VERBS = ['status', 'logs', 'restart', 'update', 'redeploy'] as const;
export type DockerVerb = (typeof DOCKER_VERBS)[number];

/** Verbs that only read. The rest mutate and register as `access: 'approval'`. */
export const READ_ONLY_VERBS: ReadonlySet<DockerVerb> = new Set<DockerVerb>(['status', 'logs']);

export interface DockerService {
  name: string;
  composeFile: string;
  /** Compose service to target within the file. Defaults to `name`. */
  service: string;
  allow: DockerVerb[];
  /** When set, only these agent groups may act on this entry. */
  agentGroups?: string[];
  description?: string;
}

export interface DockerAllowlist {
  services: DockerService[];
}

// Cache the last successfully-parsed allowlist, keyed on path + mtime — an
// edited file is picked up without a host restart, and a parse error is never
// cached permanently (mirrors the mount allowlist loader).
let cache: { path: string; mtimeMs: number; allowlist: DockerAllowlist } | null = null;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isVerb(v: unknown): v is DockerVerb {
  return typeof v === 'string' && (DOCKER_VERBS as readonly string[]).includes(v);
}

/**
 * Normalize + validate one raw entry. Returns null (with a warning) for
 * anything malformed — one bad entry is dropped, the rest of the file still
 * loads, and a dropped entry fails closed (the service is simply unknown).
 */
function normalizeService(raw: unknown): DockerService | null {
  if (typeof raw !== 'object' || raw === null) {
    log.warn('Docker allowlist: entry is not an object — skipping');
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const name = typeof entry.name === 'string' ? entry.name : '';
  if (!NAME_RE.test(name)) {
    log.warn('Docker allowlist: invalid or missing "name" — skipping entry', { name });
    return null;
  }
  const composeFile = typeof entry.composeFile === 'string' ? entry.composeFile : '';
  if (!composeFile || !path.isAbsolute(composeFile)) {
    log.warn('Docker allowlist: "composeFile" must be an absolute path — skipping entry', { name });
    return null;
  }
  const rawAllow = Array.isArray(entry.allow) ? entry.allow : [];
  const allow = rawAllow.filter(isVerb);
  if (allow.length !== rawAllow.length) {
    log.warn('Docker allowlist: unknown verb(s) dropped from entry', {
      name,
      dropped: rawAllow.filter((v) => !isVerb(v)),
    });
  }
  if (allow.length === 0) {
    log.warn('Docker allowlist: entry permits no verbs — skipping', { name });
    return null;
  }

  const service = typeof entry.service === 'string' && entry.service ? entry.service : name;
  const agentGroups =
    Array.isArray(entry.agentGroups) && entry.agentGroups.every((g) => typeof g === 'string')
      ? (entry.agentGroups as string[])
      : undefined;

  return {
    name,
    composeFile,
    service,
    allow,
    agentGroups,
    description: typeof entry.description === 'string' ? entry.description : undefined,
  };
}

/**
 * Load the allowlist. Returns an empty list when the file is absent or
 * unreadable — no file means no service is actionable, which is the intended
 * default for a fresh install.
 */
export function loadDockerAllowlist(): DockerAllowlist {
  const file = DOCKER_ALLOWLIST_PATH;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { services: [] };
  }

  if (cache && cache.path === file && cache.mtimeMs === stat.mtimeMs) {
    return cache.allowlist;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    log.error('Docker allowlist: parse error — no docker service is actionable until fixed', {
      file,
      err: e instanceof Error ? e.message : String(e),
    });
    return { services: [] };
  }

  const rawServices =
    typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).services)
      ? ((parsed as Record<string, unknown>).services as unknown[])
      : [];

  const services: DockerService[] = [];
  const seen = new Set<string>();
  for (const raw of rawServices) {
    const svc = normalizeService(raw);
    if (!svc) continue;
    if (seen.has(svc.name)) {
      log.warn('Docker allowlist: duplicate service name — keeping the first', { name: svc.name });
      continue;
    }
    seen.add(svc.name);
    services.push(svc);
  }

  const allowlist = { services };
  cache = { path: file, mtimeMs: stat.mtimeMs, allowlist };
  return allowlist;
}

/** Services visible to a caller — all of them on the host, group-filtered for an agent. */
export function visibleServices(agentGroupId: string | null): DockerService[] {
  const { services } = loadDockerAllowlist();
  if (agentGroupId === null) return services;
  return services.filter((s) => !s.agentGroups || s.agentGroups.includes(agentGroupId));
}

export type ResolveResult = { ok: true; service: DockerService } | { ok: false; error: string };

/**
 * Resolve `name` + `verb` for a caller. The single choke point every verb
 * handler goes through: unknown name, verb not permitted for that entry, and
 * entry not shared with the calling agent group all fail here, before any
 * command is built.
 *
 * An entry the caller cannot see reports as unknown rather than forbidden, so
 * the error can't be used to enumerate other groups' services.
 */
export function resolveService(name: string, verb: DockerVerb, agentGroupId: string | null): ResolveResult {
  const visible = visibleServices(agentGroupId);
  const service = visible.find((s) => s.name === name);
  if (!service) {
    const known = visible.map((s) => s.name).join(', ') || '(none configured)';
    return { ok: false, error: `Unknown docker service "${name}". Allowlisted: ${known}` };
  }
  if (!service.allow.includes(verb)) {
    return {
      ok: false,
      error: `"${verb}" is not permitted for "${name}". Permitted: ${service.allow.join(', ')}`,
    };
  }
  if (!fs.existsSync(service.composeFile)) {
    return { ok: false, error: `Compose file for "${name}" no longer exists: ${service.composeFile}` };
  }
  return { ok: true, service };
}

/** Reset the mtime cache. Test seam. */
export function resetDockerAllowlistCache(): void {
  cache = null;
}
