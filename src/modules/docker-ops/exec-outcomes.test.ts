/**
 * Outcome classification for `runDockerVerb`.
 *
 * The distinction that matters: a nonzero exit is a failure, but a capture
 * buffer overflow is NOT — the command already ran, we just stopped reading.
 * Conflating the two tells the user a deploy failed when it succeeded, and
 * invites a retry of work that already happened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execState = vi.hoisted(() => ({
  impl: null as null | ((cmd: string, args: string[], opts: unknown, cb: Function) => void),
}));

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: Function) => execState.impl!(cmd, args, opts, cb),
}));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { DockerService } from './allowlist.js';
import { runDockerVerb } from './exec.js';

const svc: DockerService = {
  name: 'my-app',
  composeFile: '/srv/app/docker-compose.yml',
  service: 'my-app',
  allow: ['status', 'update', 'redeploy'],
};

/** Fail the Nth invocation (0-indexed) with `err`; succeed on the others. */
function failOn(n: number, err: NodeJS.ErrnoException) {
  let call = 0;
  execState.impl = (_cmd, _args, _opts, cb) => {
    const isTarget = call++ === n;
    if (isTarget) cb(err, '', '');
    else cb(null, 'ok', '');
  };
}

beforeEach(() => {
  execState.impl = (_cmd, _args, _opts, cb) => cb(null, 'ok', '');
});

describe('runDockerVerb', () => {
  it('reports a buffer overflow as inconclusive, not failed', async () => {
    const err: NodeJS.ErrnoException & { stdout?: string } = Object.assign(new Error('stdout maxBuffer exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: 'Step 41/60 : RUN npm ci',
    });
    failOn(0, err);

    const r = await runDockerVerb('redeploy', svc);
    expect(r.inconclusive).toBe(true);
    expect(r.output).not.toMatch(/^FAILED/);
    expect(r.output).toMatch(/UNKNOWN/);
    // The agent is told where to go for the real answer.
    expect(r.output).toMatch(/ncl docker status --name my-app/);
  });

  it('reports a nonzero exit as failed', async () => {
    const err: NodeJS.ErrnoException & { stderr?: string } = Object.assign(new Error('exit 1'), {
      code: 1 as unknown as string,
      stderr: 'no such service',
    });
    failOn(0, err);

    const r = await runDockerVerb('redeploy', svc);
    expect(r.output).toMatch(/^FAILED/);
    expect(r.inconclusive).toBeUndefined();
  });

  it('marks a timeout kill as timedOut', async () => {
    const err: NodeJS.ErrnoException & { killed?: boolean } = Object.assign(new Error('timeout'), { killed: true });
    failOn(0, err);

    const r = await runDockerVerb('update', svc);
    expect(r.timedOut).toBe(true);
  });

  it('does not recreate the container when the pull step fails', async () => {
    failOn(0, Object.assign(new Error('pull failed'), { code: 1 as unknown as string }));

    const r = await runDockerVerb('update', svc);
    // Only the pull was attempted — `up -d` on a failed pull would silently
    // recreate on the old image and read as a successful update.
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toContain('pull');
    expect(r.output).toMatch(/^FAILED/);
  });

  it('runs both steps of a successful update', async () => {
    const r = await runDockerVerb('update', svc);
    expect(r.commands).toHaveLength(2);
    expect(r.inconclusive).toBeUndefined();
  });
});
