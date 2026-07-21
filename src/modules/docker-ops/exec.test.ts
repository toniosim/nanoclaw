/**
 * Command-shape tests.
 *
 * The argv each verb builds is the security surface — what the caller can and
 * cannot influence — so it's asserted directly rather than through a mocked
 * child process. The key invariant: every verb targets the entry's own
 * `service` and the entry's own `composeFile`, so allowlisting one service out
 * of a multi-service compose file neither exposes nor touches its neighbours.
 */
import { describe, expect, it } from 'vitest';

import type { DockerService } from './allowlist.js';
import { buildArgv, LOG_LINES_DEFAULT, LOG_LINES_MAX } from './exec.js';

const svc: DockerService = {
  name: 'sonarr',
  composeFile: '/srv/media/docker-compose.yml',
  service: 'sonarr',
  allow: ['status', 'logs', 'restart', 'update', 'redeploy'],
};

describe('buildArgv', () => {
  it('scopes status to the allowlisted service, not the whole compose file', () => {
    // A bare `ps` would report every service in the file — including ones the
    // operator never allowlisted.
    expect(buildArgv('status', svc)).toEqual([['compose', '-f', svc.composeFile, 'ps', 'sonarr']]);
  });

  it('targets the entry’s own service name when it differs from the entry name', () => {
    const aliased: DockerService = { ...svc, name: 'tv', service: 'sonarr-app' };
    for (const verb of ['status', 'logs', 'restart', 'update', 'redeploy'] as const) {
      for (const argv of buildArgv(verb, aliased)) {
        expect(argv[argv.length - 1]).toBe('sonarr-app');
      }
    }
  });

  it('always uses the allowlist’s compose file', () => {
    for (const verb of ['status', 'logs', 'restart', 'update', 'redeploy'] as const) {
      for (const argv of buildArgv(verb, svc)) {
        expect(argv.slice(0, 3)).toEqual(['compose', '-f', svc.composeFile]);
      }
    }
  });

  it('defaults and clamps the log line count', () => {
    expect(buildArgv('logs', svc)[0]).toContain(String(LOG_LINES_DEFAULT));
    expect(buildArgv('logs', svc, { lines: 10_000 })[0]).toContain(String(LOG_LINES_MAX));
    expect(buildArgv('logs', svc, { lines: 0 })[0]).toContain('1');
    expect(buildArgv('logs', svc, { lines: 12.7 })[0]).toContain('12');
  });

  it('pulls before recreating on update, so a failed pull cannot masquerade as success', () => {
    expect(buildArgv('update', svc)).toEqual([
      ['compose', '-f', svc.composeFile, 'pull', 'sonarr'],
      ['compose', '-f', svc.composeFile, 'up', '-d', 'sonarr'],
    ]);
  });

  it('builds only on redeploy', () => {
    expect(buildArgv('redeploy', svc)[0]).toContain('--build');
    expect(buildArgv('update', svc).flat()).not.toContain('--build');
    expect(buildArgv('restart', svc)[0]).not.toContain('--build');
  });
});
