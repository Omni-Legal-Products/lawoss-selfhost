#!/usr/bin/env node
// lawoss-selfhost: the host-side setup command, installed to /opt/lawoss/bin and run with sudo.
// It is the only component that touches secrets. It writes /opt/lawoss/.env (0600, root) and drives
// Docker Compose; account, backup and snapshot work runs in one-off containers. It never prints a
// secret, key, activation link or password: its outputs are host names, check results and paths
// of 0600 files. Exit codes: 0 success, 1 failure, 2 usage error.
import { spawn } from 'node:child_process';
import { accessSync, chownSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Failure, UsageError } from './lib.mjs';
import { init } from './commands/init.mjs';
import { brand } from './commands/brand.mjs';
import { invite } from './commands/invite.mjs';
import { grant, revoke, disable, list } from './commands/admin.mjs';
import { doctor, realProbes } from './commands/doctor.mjs';
import { backup, restore } from './commands/backup.mjs';
import { update, rollback } from './commands/update.mjs';
import { setKey, unsetKey } from './commands/keys.mjs';

export const USAGE = `Usage: lawoss-selfhost COMMAND
  init --base BASE --services LIST [--brand PACK] --record PATH --record-sha256 HEX
  brand check PACK [--record PATH --record-sha256 HEX] | brand preview PACK [...] | brand set PACK
  invite USER SERVICES
  grant USER SERVICES | revoke USER SERVICES | disable USER | list
  set-key NAME (value from stdin) | unset-key NAME
  doctor
  backup | restore --dry-run [BACKUP_DIR]
  update --to VERSION --record PATH --record-sha256 HEX | rollback
Environment: LAWOSS_ROOT (default /opt/lawoss).`;

const COMMANDS = {
  init, brand, invite, grant, revoke, disable, list, 'set-key': setKey, 'unset-key': unsetKey, doctor, backup, restore, update, rollback,
};

/** Runs one command with an injected context; returns the exit code. */
export async function main(argv, ctx) {
  const [name, ...args] = argv;
  if (!name || !Object.hasOwn(COMMANDS, name)) {
    ctx.err(USAGE);
    return 2;
  }
  try {
    return await COMMANDS[name](args, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.err(`lawoss-selfhost ${name}: ${error.message}`);
      ctx.err(USAGE);
      return 2;
    }
    if (error instanceof Failure) {
      ctx.err(`lawoss-selfhost ${name}: ${error.message}`);
      return 1;
    }
    // Anything else may quote a value (JSON.parse, file contents), so only its kind is printed.
    ctx.err(`lawoss-selfhost ${name}: failed (${error?.code ?? error?.name ?? 'error'})`);
    return 1;
  }
}

/**
 * Runs a command and captures its output; nothing a container prints reaches the terminal unless a
 * command re-emits it deliberately. `inherit` passes the terminal through (brand preview only).
 */
export function spawnRunner(argv, { inherit = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    const limit = 16 * 1024 * 1024;
    let size = 0;
    for (const stream of ['stdout', 'stderr'])
      child[stream]?.on('data', chunk => { size += chunk.length; if (size <= limit) chunks[stream].push(chunk); });
    child.on('error', () => resolve({ code: 127, stdout: '', stderr: '' }));
    child.on('close', code => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8'),
    }));
  });
}

/** Whether an executable `name` is on PATH (absolute entries only). */
export function onPath(name, path = process.env.PATH ?? '') {
  return path.split(delimiter).filter(dir => isAbsolute(dir)).some(dir => {
    try {
      const file = join(dir, name);
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Reads one secret value: from a terminal without echo (Enter ends it, Ctrl-C aborts), otherwise all
 * of stdin without its final newline.
 */
export function readSecret(prompt, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
      stdin.on('error', reject);
    });
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = error => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Failure('cancelled; nothing changed'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function realContext() {
  return {
    root: process.env.LAWOSS_ROOT || '/opt/lawoss',
    run: spawnRunner,
    chown: (path, uid, gid) => chownSync(path, uid, gid),
    which: name => onPath(name),
    readSecret: prompt => readSecret(prompt),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    probes: realProbes(),
    now: () => new Date(),
  };
}

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};

if (invokedDirectly()) {
  const ctx = realContext();
  if (process.getuid?.() !== 0) {
    ctx.err('lawoss-selfhost: run with sudo; it writes root-owned files and drives Docker');
    process.exitCode = 1;
  } else {
    process.umask(0o077);
    process.exitCode = await main(process.argv.slice(2), ctx);
  }
}
