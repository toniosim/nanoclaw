/**
 * `ncl docker` — act on allowlisted compose projects.
 *
 * Two independent bounds, neither of which the agent can move:
 *   1. The host allowlist (`~/.config/nanoclaw/docker-allowlist.json`, see
 *      `src/modules/docker-ops/allowlist.ts`) fixes WHICH projects exist and
 *      which verbs each permits. It is never mounted into a container and has
 *      no `ncl` write verb, so "spin up something new" has no representation
 *      here at all — an unlisted name is rejected before the guard runs.
 *   2. The verb set is fixed and closed (status/logs/restart/update/redeploy),
 *      each mapping to one hardcoded argv in `../../modules/docker-ops/exec.ts`.
 *      There is no passthrough verb and no way to supply a command or image.
 *
 * Approval comes from the standard CLI seam: read verbs register `open` and
 * answer synchronously; mutating verbs register `approval`, so the command
 * guard holds them for the group's admin chain via `cli_command` and the
 * approved replay re-runs resolution live (an entry removed between request
 * and approval fails closed).
 */
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';
import { resolveService, visibleServices, type DockerVerb } from '../../modules/docker-ops/allowlist.js';
import {
  LOG_LINES_DEFAULT,
  LOG_LINES_MAX,
  runDockerVerb,
  type DockerRunResult,
} from '../../modules/docker-ops/exec.js';

/** Host callers see every entry; an agent caller is filtered to its own group. */
function callerGroup(ctx: CallerContext): string | null {
  return ctx.caller === 'agent' ? ctx.agentGroupId : null;
}

/** Shared handler body: resolve (authorize) then execute. */
async function runVerb(verb: DockerVerb, args: Record<string, unknown>, ctx: CallerContext): Promise<DockerRunResult> {
  const name = String(args.name ?? '');
  const resolved = resolveService(name, verb, callerGroup(ctx));
  if (!resolved.ok) throw new Error(resolved.error);

  const lines = args.lines === undefined ? undefined : Number(args.lines);
  if (lines !== undefined && (!Number.isFinite(lines) || lines < 1)) {
    throw new Error('--lines must be a positive number.');
  }
  return runDockerVerb(verb, resolved.service, { lines });
}

function formatRun(data: unknown): string {
  const r = data as DockerRunResult;
  const tag = r.timedOut ? ' (TIMED OUT)' : r.inconclusive ? ' (RESULT UNKNOWN)' : '';
  const header = `${r.verb} ${r.service}${tag}`;
  return `${header}\n${'-'.repeat(header.length)}\n${r.output || '(no output)'}`;
}

const nameArg = {
  name: 'name',
  type: 'string' as const,
  description: 'Allowlisted service name (see `ncl docker list`).',
  required: true,
};

registerResource({
  name: 'docker',
  plural: 'docker',
  // No table — this resource is file-backed (the host allowlist) plus compose
  // execution. Only customOperations are registered, so no generic CRUD handler
  // ever reads `table`.
  table: '',
  description:
    'Docker compose projects the operator has allowlisted for agent use. Read verbs run immediately; ' +
    'restart/update/redeploy require admin approval. The allowlist itself is host-only — an agent cannot add a service.',
  idColumn: 'name',
  // No generic list/get, so the `scopeField` requirement for whitelisted
  // resources doesn't apply: nothing here returns raw DB rows for the
  // dispatcher to post-filter. Group scoping is enforced inside each handler
  // via the allowlist's per-entry `agentGroups`.
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        'List allowlisted docker services and the verbs each permits.\n' +
        'Shows only services shared with the calling agent group.',
      args: [],
      examples: ['ncl docker list'],
      handler: async (_args, ctx) =>
        visibleServices(callerGroup(ctx)).map((s) => ({
          name: s.name,
          service: s.service,
          composeFile: s.composeFile,
          allow: s.allow,
          description: s.description,
        })),
      formatHuman: (data) => {
        const rows = data as { name: string; allow: string[]; description?: string }[];
        if (rows.length === 0) {
          return 'No docker services are allowlisted. An operator adds them on the host with /manage-docker-ops.';
        }
        return rows
          .map((r) => `${r.name} [${r.allow.join(', ')}]${r.description ? ` — ${r.description}` : ''}`)
          .join('\n');
      },
    },
    status: {
      access: 'open',
      description: 'Show `compose ps` for an allowlisted service.',
      args: [nameArg],
      examples: ['ncl docker status --name sonarr'],
      handler: (args, ctx) => runVerb('status', args, ctx),
      formatHuman: formatRun,
    },
    logs: {
      access: 'open',
      description:
        'Tail logs for an allowlisted service.\n' +
        `--lines defaults to ${LOG_LINES_DEFAULT}, capped at ${LOG_LINES_MAX}.`,
      args: [nameArg, { name: 'lines', type: 'number', description: `Lines to tail (max ${LOG_LINES_MAX}).` }],
      examples: ['ncl docker logs --name sonarr --lines 200'],
      handler: (args, ctx) => runVerb('logs', args, ctx),
      formatHuman: formatRun,
    },
    restart: {
      access: 'approval',
      description: 'Restart an allowlisted service (`compose restart`). Requires admin approval.',
      args: [nameArg],
      examples: ['ncl docker restart --name sonarr'],
      handler: (args, ctx) => runVerb('restart', args, ctx),
      formatHuman: formatRun,
    },
    update: {
      access: 'approval',
      description:
        'Pull the image tags the compose file already pins, then recreate the service ' +
        '(`compose pull` + `compose up -d`). Requires admin approval. ' +
        'The image is whatever the compose file names — it cannot be supplied by the caller.',
      args: [nameArg],
      examples: ['ncl docker update --name sonarr'],
      handler: (args, ctx) => runVerb('update', args, ctx),
      formatHuman: formatRun,
    },
    redeploy: {
      access: 'approval',
      description:
        'Rebuild and recreate an allowlisted service from its compose file (`compose up -d --build`). ' +
        'Requires admin approval. Intended for projects you build from source; the operator opts a service ' +
        'into this by adding "redeploy" to its allowlist entry.',
      args: [nameArg],
      examples: ['ncl docker redeploy --name my-app'],
      handler: (args, ctx) => runVerb('redeploy', args, ctx),
      formatHuman: formatRun,
    },
  },
});
