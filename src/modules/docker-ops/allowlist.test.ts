/**
 * Allowlist resolution tests — this is the file that decides what an agent
 * can touch, so the cases below are the security-relevant ones: unlisted
 * names, unpermitted verbs, cross-group entries, and the mtime cache (an
 * operator's edit must take effect without a host restart).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get DOCKER_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

import { loadDockerAllowlist, resetDockerAllowlistCache, resolveService, visibleServices } from './allowlist.js';

let tmpDir: string;
let configFile: string;
let composeFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-ops-'));
  configFile = path.join(tmpDir, 'docker-allowlist.json');
  mockState.allowlistPath = configFile;
  composeFile = path.join(tmpDir, 'docker-compose.yml');
  fs.writeFileSync(composeFile, 'services: {}\n');
  resetDockerAllowlistCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAllowlist(obj: unknown): void {
  fs.writeFileSync(configFile, JSON.stringify(obj, null, 2) + '\n');
  resetDockerAllowlistCache();
}

describe('loadDockerAllowlist', () => {
  it('returns an empty list when no file exists', () => {
    expect(loadDockerAllowlist().services).toEqual([]);
  });

  it('defaults the compose service name to the entry name', () => {
    writeAllowlist({ services: [{ name: 'sonarr', composeFile, allow: ['status'] }] });
    expect(loadDockerAllowlist().services[0].service).toBe('sonarr');
  });

  it('drops entries with a relative compose path', () => {
    writeAllowlist({ services: [{ name: 'bad', composeFile: 'relative/compose.yml', allow: ['status'] }] });
    expect(loadDockerAllowlist().services).toEqual([]);
  });

  it('drops unknown verbs but keeps the rest of the entry', () => {
    writeAllowlist({ services: [{ name: 'sonarr', composeFile, allow: ['status', 'exec', 'rm -rf'] }] });
    expect(loadDockerAllowlist().services[0].allow).toEqual(['status']);
  });

  it('drops an entry left with no permitted verbs', () => {
    writeAllowlist({ services: [{ name: 'sonarr', composeFile, allow: ['exec'] }] });
    expect(loadDockerAllowlist().services).toEqual([]);
  });

  // A malformed narrowing field must never widen the entry — the failure mode
  // that matters is "restricted entry silently becomes visible to everyone".
  it.each([
    ['a bare string instead of an array', 'group-a'],
    ['an array with a non-string element', ['group-a', 123]],
    ['an array with an empty string', ['group-a', '']],
    ['an object', { 0: 'group-a' }],
  ])('drops an entry whose agentGroups is %s', (_label, agentGroups) => {
    writeAllowlist({ services: [{ name: 'scoped', composeFile, allow: ['status'], agentGroups }] });
    expect(loadDockerAllowlist().services).toEqual([]);
    // ...and specifically is not visible to an unrelated agent group.
    expect(visibleServices('group-b')).toEqual([]);
  });

  it('treats an absent agentGroups as shared with any group', () => {
    writeAllowlist({ services: [{ name: 'shared', composeFile, allow: ['status'] }] });
    expect(visibleServices('any-group').map((s) => s.name)).toEqual(['shared']);
  });

  it('defaults the compose binary to docker', () => {
    writeAllowlist({ services: [] });
    expect(loadDockerAllowlist().binary).toBe('docker');
  });

  it('honors a configured compose binary', () => {
    writeAllowlist({ binary: 'podman', services: [] });
    expect(loadDockerAllowlist().binary).toBe('podman');
  });

  it.each([['docker compose'], ['/usr/bin/docker'], ['docker; rm -rf /'], ['']])(
    'falls back to docker for the invalid binary %j',
    (binary) => {
      writeAllowlist({ binary, services: [] });
      expect(loadDockerAllowlist().binary).toBe('docker');
    },
  );

  it('fails closed on a parse error rather than serving a stale list', () => {
    writeAllowlist({ services: [{ name: 'sonarr', composeFile, allow: ['status'] }] });
    expect(loadDockerAllowlist().services).toHaveLength(1);
    fs.writeFileSync(configFile, '{ not json');
    resetDockerAllowlistCache();
    expect(loadDockerAllowlist().services).toEqual([]);
  });

  it('picks up an edited file without a restart (mtime-keyed cache)', async () => {
    writeAllowlist({ services: [{ name: 'sonarr', composeFile, allow: ['status'] }] });
    expect(loadDockerAllowlist().services).toHaveLength(1);
    // Same process, no cache reset — only the file changes.
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        services: [
          { name: 'sonarr', composeFile, allow: ['status'] },
          { name: 'radarr', composeFile, allow: ['status'] },
        ],
      }),
    );
    expect(loadDockerAllowlist().services).toHaveLength(2);
  });
});

describe('visibleServices', () => {
  beforeEach(() => {
    writeAllowlist({
      services: [
        { name: 'shared', composeFile, allow: ['status'] },
        { name: 'scoped', composeFile, allow: ['status'], agentGroups: ['group-a'] },
      ],
    });
  });

  it('shows every entry to a host caller', () => {
    expect(visibleServices(null).map((s) => s.name)).toEqual(['shared', 'scoped']);
  });

  it('hides a scoped entry from other agent groups', () => {
    expect(visibleServices('group-b').map((s) => s.name)).toEqual(['shared']);
    expect(visibleServices('group-a').map((s) => s.name)).toEqual(['shared', 'scoped']);
  });
});

describe('resolveService', () => {
  beforeEach(() => {
    writeAllowlist({
      services: [
        { name: 'sonarr', composeFile, allow: ['status', 'restart'] },
        { name: 'scoped', composeFile, allow: ['status'], agentGroups: ['group-a'] },
      ],
    });
  });

  it('rejects a name that is not on the allowlist', () => {
    const r = resolveService('nginx', 'restart', null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Unknown docker service "nginx"/);
  });

  it('rejects a verb the entry does not permit', () => {
    const r = resolveService('sonarr', 'redeploy', null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/not permitted/);
  });

  it('reports an out-of-group entry as unknown, not forbidden', () => {
    // "forbidden" would confirm the entry exists — an enumeration oracle.
    const r = resolveService('scoped', 'status', 'group-b');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Unknown docker service/);
  });

  it('rejects an entry whose compose file has since disappeared', () => {
    fs.rmSync(composeFile);
    const r = resolveService('sonarr', 'status', null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/no longer exists/);
  });

  it('resolves a permitted verb for a visible entry', () => {
    const r = resolveService('sonarr', 'restart', 'group-b');
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.service.composeFile).toBe(composeFile);
  });
});
