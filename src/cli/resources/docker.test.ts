/**
 * `ncl docker` at the dispatch level — the two claims that matter:
 *   - read verbs run straight through for a group-scoped agent,
 *   - mutating verbs never reach the handler without an admin approval.
 *
 * Compose execution is mocked; what's under test is the authorization path,
 * not docker itself.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ allowlistPath: '' }));
const execState = vi.hoisted(() => ({ runDockerVerb: vi.fn() }));
const approvalState = vi.hoisted(() => ({ requestApproval: vi.fn(), registerApprovalHandler: vi.fn() }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get DOCKER_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../modules/docker-ops/exec.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../modules/docker-ops/exec.js');
  return { ...actual, runDockerVerb: execState.runDockerVerb };
});

const mockGetContainerConfig = vi.fn();
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

const mockGetAgentGroup = vi.fn();
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetSession = vi.fn();
const mockGetPendingApproval = vi.fn();
vi.mock('../../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
}));

vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: approvalState.registerApprovalHandler,
  requestApproval: approvalState.requestApproval,
}));

import { resetDockerAllowlistCache } from '../../modules/docker-ops/allowlist.js';
import { dispatch } from '../dispatch.js';
import './docker.js';

const AGENT = { caller: 'agent' as const, sessionId: 's1', agentGroupId: 'group-a', messagingGroupId: 'mg1' };
const HOST = { caller: 'host' as const };

let tmpDir: string;
let composeFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cli-'));
  composeFile = path.join(tmpDir, 'docker-compose.yml');
  fs.writeFileSync(composeFile, 'services: {}\n');
  mockState.allowlistPath = path.join(tmpDir, 'docker-allowlist.json');
  fs.writeFileSync(
    mockState.allowlistPath,
    JSON.stringify({
      services: [
        { name: 'sonarr', composeFile, allow: ['status', 'logs', 'restart', 'update'] },
        { name: 'other-group-app', composeFile, allow: ['status', 'redeploy'], agentGroups: ['group-b'] },
      ],
    }),
  );
  resetDockerAllowlistCache();

  mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
  mockGetAgentGroup.mockReturnValue({ id: 'group-a', name: 'Home Server' });
  mockGetSession.mockReturnValue({ id: 's1', agent_group_id: 'group-a' });
  execState.runDockerVerb.mockResolvedValue({ service: 'sonarr', verb: 'status', commands: [], output: 'Up 3 hours' });
});

describe('read verbs', () => {
  it('run immediately for a group-scoped agent', async () => {
    const resp = await dispatch({ id: 'r1', command: 'docker-status', args: { name: 'sonarr' } }, AGENT);
    expect(resp.ok).toBe(true);
    expect(execState.runDockerVerb).toHaveBeenCalledOnce();
    expect(approvalState.requestApproval).not.toHaveBeenCalled();
  });

  it('list hides entries scoped to another agent group', async () => {
    const resp = await dispatch({ id: 'r2', command: 'docker-list', args: {} }, AGENT);
    expect(resp.ok).toBe(true);
    const names = (resp.ok === true ? (resp.data as { name: string }[]) : []).map((s) => s.name);
    expect(names).toEqual(['sonarr']);
  });
});

describe('mutating verbs', () => {
  it('hold for admin approval instead of executing', async () => {
    const resp = await dispatch({ id: 'r3', command: 'docker-restart', args: { name: 'sonarr' } }, AGENT);
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.code).toBe('approval-pending');
    expect(approvalState.requestApproval).toHaveBeenCalledOnce();
    expect(execState.runDockerVerb).not.toHaveBeenCalled();
  });

  it('execute for a host caller (the trusted socket)', async () => {
    const resp = await dispatch({ id: 'r4', command: 'docker-restart', args: { name: 'sonarr' } }, HOST);
    expect(resp.ok).toBe(true);
    expect(execState.runDockerVerb).toHaveBeenCalledOnce();
  });
});

describe('allowlist bounds', () => {
  it('rejects a service that is not allowlisted at all', async () => {
    const resp = await dispatch({ id: 'r5', command: 'docker-status', args: { name: 'nginx' } }, AGENT);
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/Unknown docker service/);
    expect(execState.runDockerVerb).not.toHaveBeenCalled();
  });

  it('rejects a verb the entry does not permit, even with approval available', async () => {
    // sonarr allows status/logs/restart/update — redeploy is not on its list.
    const resp = await dispatch({ id: 'r6', command: 'docker-redeploy', args: { name: 'sonarr' } }, HOST);
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/not permitted/);
    expect(execState.runDockerVerb).not.toHaveBeenCalled();
  });

  it('hides another group’s entry from a group-scoped agent', async () => {
    const resp = await dispatch({ id: 'r7', command: 'docker-status', args: { name: 'other-group-app' } }, AGENT);
    expect(resp.ok).toBe(false);
    expect(resp.ok === false && resp.error.message).toMatch(/Unknown docker service/);
  });
});
