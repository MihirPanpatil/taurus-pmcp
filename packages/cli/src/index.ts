#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import restObserver from '@taurus/adapter-rest-observer';
import { BINDERS, SCHEMAS, verifyApp } from '@taurus/capabilities';
import { EventEmitter } from 'node:events';
import { ApprovalBroker, compile, consoleLogger, PmcpStore, Runtime, ShapeAggregator, type AppModel } from '@taurus/core';
import { DEFAULT_PORT, startGateway } from '@taurus/gateway';
import { createMonitor } from '@taurus/monitor';

const ADAPTERS = [restObserver];

const HELP = `Taurus walking skeleton

Usage: taurus <command> [options]

  compile <url> --app-id <id>   Open the app in the Taurus shell, record it and compile a PMCP
      --exercise <file>          Drive the page with a script instead of recording by hand
      --record                   Show the window; use the app, then close it to compile
      --show                     Show the window while an exercise runs
      --no-verify                Skip the conformance suite
      --verbose                  Log requests that were seen but not kept
      --cdp-port <n>             Development only: expose the session over CDP on 127.0.0.1
  recompile <appId>             Compile again from the last saved capture (no browsing)
  verify <appId>                Run the conformance suite in a scratch project
  apps                          List compiled apps
  tools <appId> [--profile p]   List tools with their effect, state and confidence
  enable <appId> <slot>         Switch a tool on for a profile (risky tools still ask every time)
  disable <appId> <slot>        Switch a tool off for a profile
  token <appId> [--profile p]   Print the MCP endpoint and bearer token
  serve [--port n]              Serve every PMCP over MCP on 127.0.0.1 (default ${DEFAULT_PORT}), plus the monitor

Global: --data-dir <dir> (default: $TAURUS_DATA_DIR or ~/.taurus)`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  const valued = new Set(['--app-id', '--exercise', '--profile', '--port', '--data-dir', '--cdp-port']);
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i])) i++;
    else if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

function printVerification(model: AppModel): void {
  for (const result of model.verification ?? []) {
    console.log(`${result.schema} conformance: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
    for (const step of result.steps) console.log(`  ${step.status.padEnd(7)} ${step.name}${step.detail ? ` (${step.detail})` : ''}`);
  }
}

/** Streams new lines of the shell's log file to our stdout until the shell exits. */
async function runShell(args: string[]): Promise<number> {
  const require = createRequire(import.meta.url);
  const shellDir = dirname(require.resolve('@taurus/shell/package.json'));
  const electron = createRequire(`${shellDir}/package.json`)('electron') as string;
  const logDir = await mkdtemp(join(tmpdir(), 'taurus-shell-'));
  const logFile = join(logDir, 'shell.log');
  await writeFile(logFile, '');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Arguments go after "--" so Chromium doesn't treat flags such as --app-id as its own.
  const child = spawn(electron, [shellDir, '--', ...args, '--log-file', logFile], { stdio: 'ignore', env });

  let printed = 0;
  const flush = async () => {
    const text = await readFile(logFile, 'utf8');
    if (text.length > printed) {
      process.stdout.write(text.slice(printed));
      printed = text.length;
    }
  };
  const timer = setInterval(() => void flush(), 250);
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
  clearInterval(timer);
  await flush();
  await rm(logDir, { recursive: true, force: true });
  return code;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const dataDir = option(rest, 'data-dir');
  const store = new PmcpStore(dataDir);
  const args = positional(rest);
  const profile = option(rest, 'profile') ?? 'default';

  switch (command) {
    case 'compile': {
      const url = args[0];
      const appId = option(rest, 'app-id');
      if (!url || !appId) throw new Error('usage: taurus compile <url> --app-id <id>');
      const shellArgs = ['--url', url, '--app-id', appId];
      for (const name of ['exercise', 'data-dir', 'cdp-port']) {
        const value = option(rest, name);
        if (value) shellArgs.push(`--${name}`, value);
      }
      for (const name of ['record', 'show', 'no-verify', 'verbose']) if (rest.includes(`--${name}`)) shellArgs.push(`--${name}`);
      return runShell(shellArgs);
    }

    case 'recompile': {
      const appId = args[0];
      if (!appId) throw new Error('usage: taurus recompile <appId>');
      const capture = await store.loadCapture(appId);
      const model = await compile({
        appId,
        origin: capture.origin,
        adapters: ADAPTERS,
        binders: BINDERS,
        network: ShapeAggregator.fromShapes(capture.origin, capture.shapes),
        log: consoleLogger,
      });
      await store.saveModel(model);
      if (!rest.includes('--no-verify')) printVerification(await verifyApp(appId, { store, adapters: ADAPTERS }));
      return 0;
    }

    case 'verify': {
      const appId = args[0];
      if (!appId) throw new Error('usage: taurus verify <appId>');
      const model = await verifyApp(appId, { store, adapters: ADAPTERS });
      printVerification(model);
      return (model.verification ?? []).some((v) => v.failed > 0) ? 1 : 0;
    }

    case 'apps': {
      const apps = await store.listApps();
      if (apps.length === 0) console.log('No PMCPs compiled yet. Try: taurus compile <url> --app-id <id>');
      for (const appId of apps) {
        const model = await store.loadModel(appId);
        console.log(`${appId.padEnd(24)} ${model.app.origin}  build ${model.app.build.fingerprint}`);
      }
      return 0;
    }

    case 'tools': {
      const appId = args[0];
      if (!appId) throw new Error('usage: taurus tools <appId>');
      const runtime = new Runtime({ store, adapters: ADAPTERS, schemas: SCHEMAS });
      for (const tool of await runtime.describeTools(appId, profile)) {
        console.log(
          `${tool.enabled ? 'on ' : 'off'}  ${tool.name.padEnd(24)} ${tool.effect.padEnd(8)} confidence ${tool.confidence.toFixed(2)}`,
        );
      }
      return 0;
    }

    case 'enable':
    case 'disable': {
      const [appId, slot] = args;
      if (!appId || !slot) throw new Error(`usage: taurus ${command} <appId> <slot>`);
      const slotName = slot.includes('.') ? slot : slot.replace(/_/g, '.');
      await store.setSlotEnabled(appId, profile, slotName, command === 'enable');
      console.log(`${slotName} ${command}d for profile "${profile}"`);
      return 0;
    }

    case 'token': {
      const appId = args[0];
      if (!appId) throw new Error('usage: taurus token <appId>');
      const target = (await store.getProfiles(appId)).find((p) => p.name === profile);
      if (!target) throw new Error(`no profile "${profile}"`);
      const port = Number(option(rest, 'port') ?? DEFAULT_PORT);
      console.log(`endpoint: http://127.0.0.1:${port}/pmcp/${appId}/${profile}/mcp`);
      console.log(`token:    ${target.token}`);
      return 0;
    }

    case 'serve': {
      const broker = new ApprovalBroker();
      const events = new EventEmitter();
      const runtime = new Runtime({ store, adapters: ADAPTERS, schemas: SCHEMAS, approve: broker.handler, events, log: consoleLogger });
      const monitorToken = await store.monitorToken();
      const monitor = createMonitor({ store, runtime, broker, events, adapters: ADAPTERS, token: monitorToken });
      const gateway = await startGateway({ runtime, store, port: Number(option(rest, 'port') ?? DEFAULT_PORT), extensions: [monitor] });
      console.log(`Taurus gateway on ${gateway.url}`);
      console.log(`\nMonitor (approve risky calls here):\n  ${gateway.url}/monitor/#token=${monitorToken}\n`);
      const apps = await store.listApps();
      if (apps.length) console.log('PMCP endpoints:');
      for (const appId of apps) {
        for (const p of await store.getProfiles(appId)) console.log(`  ${gateway.endpoint(appId, p.name)}`);
      }
      console.log('\nGet a bearer token with: taurus token <appId>, or copy it from the monitor. Press Ctrl+C to stop.');
      await new Promise(() => {});
      return 0;
    }

    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return 0;

    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
