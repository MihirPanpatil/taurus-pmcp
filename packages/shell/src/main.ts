// Taurus shell, walking-skeleton edition: opens an app in its own session, records its traffic as shapes
// (scripted with --exercise, or by hand with --record), then compiles, saves and verifies the PMCP.
import { appendFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import restObserver from '@taurus/adapter-rest-observer';
import type { Logger } from '@taurus/adapter-sdk';
import { BINDERS, verifyApp } from '@taurus/capabilities';
import { reaSource } from '@taurus/analysis-rea';
import { compile, defaultDataDir, PmcpStore, type AnalysisFindings, type AnalysisSource } from '@taurus/core';
import { NetworkCapture } from './capture.js';

// Electron's stdout isn't reliably visible on Windows, so the CLI passes --log-file and streams that file instead.
const logFile = (() => {
  const i = process.argv.indexOf('--log-file');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

function write(line: string): void {
  if (logFile) appendFileSync(logFile, line + '\n', 'utf8');
  else console.log(line);
}

const log: Logger = {
  info: (message) => write(`[taurus] ${message}`),
  warn: (message) => write(`[taurus] warning: ${message}`),
};

interface ShellArgs {
  url: string;
  appId: string;
  exercise?: string;
  record: boolean;
  show: boolean;
  verify: boolean;
  verbose: boolean;
  cdpPort?: number;
  /** Optional analysis sources to run, e.g. ["rea"]. */
  analyze: string[];
  dataDir?: string;
}

const ANALYSIS_SOURCES: Record<string, () => AnalysisSource> = { rea: () => reaSource() };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]): ShellArgs {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const url = value('url');
  const appId = value('app-id');
  if (!url || !appId) throw new Error('usage: taurus-shell --url <url> --app-id <id> [--exercise <file>] [--record] [--show] [--no-verify]');
  return {
    url,
    appId,
    exercise: value('exercise'),
    record: flag('record'),
    show: flag('show'),
    verify: !flag('no-verify'),
    verbose: flag('verbose'),
    cdpPort: value('cdp-port') ? Number(value('cdp-port')) : undefined,
    analyze: (value('analyze') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: value('data-dir'),
  };
}

/** Reads the loopback CDP port Chromium picked (with --remote-debugging-port=0). */
async function cdpEndpoint(args: ShellArgs): Promise<string> {
  if (args.cdpPort) return `http://127.0.0.1:${args.cdpPort}`;
  const file = join(app.getPath('userData'), 'DevToolsActivePort');
  for (let i = 0; i < 50; i++) {
    try {
      const port = (await readFile(file, 'utf8')).split('\n')[0].trim();
      if (/^\d{1,5}$/.test(port)) return `http://127.0.0.1:${port}`;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error('the browser did not report its debugging port');
}

/** Runs the requested analysis sources against the open page. Failures are logged, never fatal. */
async function runAnalysis(args: ShellArgs, win: BrowserWindow, origin: string): Promise<AnalysisFindings[]> {
  const findings: AnalysisFindings[] = [];
  if (args.analyze.length === 0) return findings;
  let target: { cdpEndpoint: string; targetId: string; origin: string };
  try {
    const info = (await win.webContents.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    target = { cdpEndpoint: await cdpEndpoint(args), targetId: info.targetInfo.targetId, origin };
  } catch (error) {
    log.warn(`analysis skipped: ${error instanceof Error ? error.message : String(error)}`);
    return findings;
  }
  for (const id of args.analyze) {
    const create = ANALYSIS_SOURCES[id];
    if (!create) {
      log.warn(`unknown analysis source "${id}" (available: ${Object.keys(ANALYSIS_SOURCES).join(', ')})`);
      continue;
    }
    try {
      log.info(`running analysis source "${id}"`);
      const result = await create().analyze(target, log);
      log.info(`${id}: ${result.endpoints.length} endpoints and ${result.declaredTools.length} declared tools found in code`);
      findings.push(result);
    } catch (error) {
      log.warn(`analysis source "${id}" failed, continuing without it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return findings;
}

async function run(args: ShellArgs): Promise<void> {
  const origin = new URL(args.url).origin;
  const store = new PmcpStore(args.dataDir);
  store.appDir(args.appId); // validates the id before opening anything

  const win = new BrowserWindow({
    show: args.show || args.record,
    width: 1100,
    height: 800,
    title: `Taurus · ${args.appId}`,
    webPreferences: {
      partition: `persist:taurus-${args.appId}`,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // The compile session stays on the app's own site.
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Attach to a blank page first so capture is running before the app's first request.
  await win.loadURL('about:blank');
  const capture = new NetworkCapture(
    win.webContents,
    origin,
    args.verbose ? (reason, method, url) => log.info(`skipped ${method} ${url}: ${reason}`) : undefined,
  );
  await capture.start();
  log.info(`opening ${args.url} in profile "taurus-${args.appId}"`);
  await win.loadURL(args.url);

  let analysis: AnalysisFindings[] = [];
  if (args.exercise) {
    const code = await readFile(resolve(args.exercise), 'utf8');
    const result: unknown = await win.webContents.executeJavaScript(code, true);
    log.info(`exercise finished: ${String(result)}`);
    await capture.idle();
    analysis = await runAnalysis(args, win, origin);
  } else if (args.record) {
    // The page closes when recording ends, so analysis runs first.
    analysis = await runAnalysis(args, win, origin);
    log.info('Recording. Use the app normally, then close the window to compile.');
    await new Promise<void>((done) => win.once('closed', () => done()));
  } else {
    await capture.idle(1000);
    analysis = await runAnalysis(args, win, origin);
  }

  capture.stop();
  if (!win.isDestroyed()) win.destroy();

  const shapes = capture.aggregator.toJSON();
  log.info(`captured ${shapes.length} endpoint shapes from ${origin}`);
  await store.saveCapture(args.appId, origin, shapes, analysis);

  const model = await compile({
    appId: args.appId,
    origin,
    adapters: [restObserver],
    binders: BINDERS,
    network: capture.aggregator,
    analysis,
    log,
  });
  await store.saveModel(model);
  log.info(`saved PMCP "${args.appId}" (build ${model.app.build.fingerprint}, ${model.operations.length} operations)`);

  if (args.verify) {
    const verified = await verifyApp(args.appId, { store, adapters: [restObserver] });
    for (const result of verified.verification ?? []) {
      log.info(`${result.schema} conformance: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
      for (const step of result.steps) write(`  ${step.status.padEnd(7)} ${step.name}${step.detail ? ` (${step.detail})` : ''}`);
    }
  }
}

app.on('window-all-closed', () => {
  // Keep running after the record window closes; run() decides when to exit.
});

let args: ShellArgs;
try {
  args = parseArgs(process.argv);
  // Browser profiles (cookies, storage) live with the rest of the Taurus data, one partition per app.
  app.setPath('userData', join(resolve(args.dataDir ?? defaultDataDir()), 'browser'));
  // Analysis sources (and the dev-only --cdp-port) attach over CDP. Any local process could attach while the port
  // is open, so it is loopback-only, opt-in, and closes when this compile ends.
  if (args.cdpPort || args.analyze.length > 0) {
    if (!args.cdpPort) rmSync(join(app.getPath('userData'), 'DevToolsActivePort'), { force: true });
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', String(args.cdpPort ?? 0));
  }
} catch (error) {
  write(`[taurus] error: ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
  throw error;
}

app
  .whenReady()
  .then(() => run(args))
  .then(
    () => app.exit(0),
    (error: unknown) => {
      write(`[taurus] error: ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    },
  );
