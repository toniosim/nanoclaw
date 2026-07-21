/**
 * Fixed compose command shapes.
 *
 * Every verb maps to one hardcoded argv built here — same discipline as
 * `install_packages`, which only ever runs apt/npm over validated names. The
 * agent supplies a service *name* (matched against the allowlist) and, for
 * logs, a line count; it never supplies a command, an image, a flag, or a
 * path. Nothing here goes through a shell: `execFile` with an argv array, so
 * there is no word-splitting or metacharacter surface even if a malformed
 * allowlist entry reached it.
 *
 * `-f <composeFile>` always comes from the allowlist entry, never the caller,
 * which is what keeps "act on an allowlisted project" from widening into "act
 * on any compose file on the host". Every verb also targets the entry's own
 * `service`, so allowlisting one service out of a multi-service file does not
 * expose or act on its neighbours.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { log } from '../../log.js';
import { loadDockerAllowlist, type DockerService, type DockerVerb } from './allowlist.js';

const execFileAsync = promisify(execFile);

/** Per-verb wall-clock ceiling. Image pulls and builds are the slow ones. */
const TIMEOUTS: Record<DockerVerb, number> = {
  status: 30_000,
  logs: 30_000,
  restart: 120_000,
  update: 600_000,
  redeploy: 900_000,
};

/**
 * Cap on captured output. Generous because overflow is not a clean failure:
 * the command has already run by the time the buffer fills, so a low cap turns
 * successful builds into unreportable ones (see the ENOBUFS branch below).
 */
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 16_000;

export const LOG_LINES_DEFAULT = 100;
export const LOG_LINES_MAX = 500;

export interface DockerRunResult {
  service: string;
  verb: DockerVerb;
  /** The argv sequences actually executed, for the audit trail. */
  commands: string[];
  output: string;
  timedOut?: boolean;
  /**
   * The command ran but its result could not be determined (output overflowed
   * the capture buffer). NOT a failure — callers must not present it as one.
   */
  inconclusive?: boolean;
}

/** Keep the tail — the end of a build or log stream is the informative part. */
function clampOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `[...truncated ${text.length - MAX_OUTPUT_CHARS} chars...]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

/** The compose driver for the operator's own services (allowlist-configured). */
export function composeBinary(): string {
  return loadDockerAllowlist().binary;
}

/**
 * The argv (after the compose binary) for each verb. `update` is two steps:
 * pull the tags the compose file already pins, then recreate. The caller
 * cannot influence which image is pulled — that is whatever the operator
 * wrote in the compose file.
 *
 * Exported for tests: these argv shapes are the security surface, so they are
 * asserted directly rather than through a mocked child process.
 */
export function buildArgv(verb: DockerVerb, svc: DockerService, opts: { lines?: number } = {}): string[][] {
  const base = ['compose', '-f', svc.composeFile];
  const target = svc.service;
  switch (verb) {
    case 'status':
      // Targeted: a bare `ps` would report every service in the compose file,
      // including ones the operator never allowlisted.
      return [[...base, 'ps', target]];
    case 'logs': {
      const lines = Math.min(Math.max(Math.trunc(opts.lines ?? LOG_LINES_DEFAULT), 1), LOG_LINES_MAX);
      return [[...base, 'logs', '--no-color', '--tail', String(lines), target]];
    }
    case 'restart':
      return [[...base, 'restart', target]];
    case 'update':
      return [
        [...base, 'pull', target],
        [...base, 'up', '-d', target],
      ];
    case 'redeploy':
      return [[...base, 'up', '-d', '--build', target]];
  }
}

/**
 * Run one verb against one allowlisted service. Resolution (name known, verb
 * permitted, group allowed) has already happened in `resolveService` — this
 * function assumes an authorized request and only builds and executes.
 */
export async function runDockerVerb(
  verb: DockerVerb,
  svc: DockerService,
  opts: { lines?: number } = {},
): Promise<DockerRunResult> {
  const sequences = buildArgv(verb, svc, opts);
  const bin = composeBinary();
  const cwd = path.dirname(svc.composeFile);
  const chunks: string[] = [];
  const commands: string[] = [];

  for (const argv of sequences) {
    const rendered = `${bin} ${argv.join(' ')}`;
    commands.push(rendered);
    log.info('docker-ops: executing', { service: svc.name, verb, command: rendered });
    try {
      const { stdout, stderr } = await execFileAsync(bin, argv, {
        cwd,
        timeout: TIMEOUTS[verb],
        maxBuffer: MAX_BUFFER,
      });
      chunks.push([stdout, stderr].filter(Boolean).join('\n').trim());
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim() || err.message;

      // Buffer overflow is not an exit code — the command ran to completion (or
      // is running still) and we simply stopped capturing. Reporting it as a
      // failure would tell the user a deploy failed when it succeeded.
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        log.warn('docker-ops: output exceeded capture buffer — result unknown', {
          service: svc.name,
          verb,
          command: rendered,
        });
        return {
          service: svc.name,
          verb,
          commands,
          inconclusive: true,
          output: clampOutput(
            `${rendered} produced more output than could be captured, so its result is UNKNOWN — it may well have succeeded. ` +
              `Do not report this as a failure; check \`ncl docker status --name ${svc.name}\` to see the actual state.\n\n${detail}`,
          ),
        };
      }

      chunks.push(detail);
      log.error('docker-ops: command failed', { service: svc.name, verb, command: rendered, err: err.message });
      // Stop the sequence — `up -d` after a failed `pull` would silently
      // recreate on the old image and read as a successful update.
      return {
        service: svc.name,
        verb,
        commands,
        output: clampOutput(`FAILED: ${rendered}\n${detail}`),
        timedOut: err.killed === true,
      };
    }
  }

  return { service: svc.name, verb, commands, output: clampOutput(chunks.filter(Boolean).join('\n\n')) };
}
