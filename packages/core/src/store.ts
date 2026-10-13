import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NetworkShape } from '@taurus/adapter-sdk';
import type { AnalysisFindings } from './analysis.js';
import type { AppModel } from './model.js';

export interface Profile {
  name: string;
  /** Bearer token for this profile's MCP endpoint. TODO: move to the OS key store (ARCHITECTURE section 11). */
  token: string;
  /** Slots switched on beyond the defaults. */
  enabled?: string[];
  /** Slots switched off. */
  disabled?: string[];
}

export interface Manifest {
  appId: string;
  origin: string;
  activeBuild: string;
  builds: string[];
  updatedAt: string;
}

export interface AuditEntry {
  at: string;
  profile: string;
  tool: string;
  effect: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface SavedCapture {
  origin: string;
  capturedAt: string;
  shapes: NetworkShape[];
  analysis?: AnalysisFindings[];
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEEP_BUILDS = 3;

export function defaultDataDir(): string {
  return process.env.TAURUS_DATA_DIR ?? join(homedir(), '.taurus');
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** On-disk PMCP bundles (ARCHITECTURE section 4). */
export class PmcpStore {
  readonly dataDir: string;

  constructor(dataDir: string = defaultDataDir()) {
    this.dataDir = resolve(dataDir);
  }

  appDir(appId: string): string {
    if (!APP_ID.test(appId)) throw new Error(`invalid app id "${appId}" (use lowercase letters, digits and dashes)`);
    return join(this.dataDir, 'pmcp', appId);
  }

  async saveModel(model: AppModel): Promise<Manifest> {
    const dir = this.appDir(model.app.id);
    await mkdir(join(dir, 'models'), { recursive: true });
    const build = model.app.build.fingerprint.replace(/[^a-z0-9]+/gi, '-');
    await writeJson(join(dir, 'models', `${build}.json`), model);

    const previous = await readJson<Manifest>(join(dir, 'manifest.json'));
    const builds = [build, ...(previous?.builds ?? []).filter((b) => b !== build)];
    for (const old of builds.slice(KEEP_BUILDS)) await rm(join(dir, 'models', `${old}.json`), { force: true });
    const manifest: Manifest = {
      appId: model.app.id,
      origin: model.app.origin,
      activeBuild: build,
      builds: builds.slice(0, KEEP_BUILDS),
      updatedAt: new Date().toISOString(),
    };
    await writeJson(join(dir, 'manifest.json'), manifest);
    await this.getProfiles(model.app.id); // create the default profile on first save
    return manifest;
  }

  async loadModel(appId: string): Promise<AppModel> {
    const dir = this.appDir(appId);
    const manifest = await readJson<Manifest>(join(dir, 'manifest.json'));
    if (!manifest) throw new Error(`no PMCP compiled for "${appId}"`);
    const model = await readJson<AppModel>(join(dir, 'models', `${manifest.activeBuild}.json`));
    if (!model) throw new Error(`active build of "${appId}" is missing`);
    return model;
  }

  async listApps(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.dataDir, 'pmcp'));
      const apps: string[] = [];
      for (const entry of entries) {
        if (APP_ID.test(entry) && (await stat(join(this.dataDir, 'pmcp', entry, 'manifest.json')).catch(() => null))) {
          apps.push(entry);
        }
      }
      return apps.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async getProfiles(appId: string): Promise<Profile[]> {
    const path = join(this.appDir(appId), 'profiles.json');
    const file = await readJson<{ profiles: Profile[] }>(path);
    if (file?.profiles?.length) return file.profiles;
    const profiles = [{ name: 'default', token: newToken() }];
    await mkdir(this.appDir(appId), { recursive: true });
    await writeJson(path, { profiles });
    return profiles;
  }

  async saveProfiles(appId: string, profiles: Profile[]): Promise<void> {
    await writeJson(join(this.appDir(appId), 'profiles.json'), { profiles });
  }

  /** Saves the shapes from a compile session so the app can be recompiled without browsing it again. */
  async saveCapture(appId: string, origin: string, shapes: NetworkShape[], analysis: AnalysisFindings[] = []): Promise<void> {
    const dir = join(this.appDir(appId), 'captures');
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, 'latest.json'), { origin, capturedAt: new Date().toISOString(), shapes, analysis });
  }

  async loadCapture(appId: string): Promise<SavedCapture> {
    const capture = await readJson<SavedCapture>(join(this.appDir(appId), 'captures', 'latest.json'));
    if (!capture) throw new Error(`no saved capture for "${appId}"`);
    return capture;
  }

  /** Switches a slot on or off for one profile. Risky tools still ask for confirmation on every call. */
  async setSlotEnabled(appId: string, profileName: string, slot: string, enabled: boolean): Promise<Profile> {
    const profiles = await this.getProfiles(appId);
    const profile = profiles.find((p) => p.name === profileName);
    if (!profile) throw new Error(`no profile "${profileName}" for "${appId}"`);
    const on = new Set(profile.enabled ?? []);
    const off = new Set(profile.disabled ?? []);
    if (enabled) {
      on.add(slot);
      off.delete(slot);
    } else {
      off.add(slot);
      on.delete(slot);
    }
    profile.enabled = [...on].sort();
    profile.disabled = [...off].sort();
    await this.saveProfiles(appId, profiles);
    return profile;
  }

  /** The newest audit entries first. */
  async readAudit(appId: string, limit = 50): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(join(this.appDir(appId), 'audit.log'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: AuditEntry[] = [];
    const lines = text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        entries.push(JSON.parse(lines[i]) as AuditEntry);
      } catch {
        // skip a partially written line
      }
    }
    return entries;
  }

  /** Token for the monitor PWA. Kept across restarts so an installed monitor keeps working. */
  async monitorToken(): Promise<string> {
    const path = join(this.dataDir, 'monitor.json');
    const existing = await readJson<{ token: string }>(path);
    if (existing?.token) return existing.token;
    const token = newToken();
    await mkdir(this.dataDir, { recursive: true });
    await writeJson(path, { token });
    return token;
  }

  /** Records what was called and how it went. Inputs and outputs are not logged. */
  async appendAudit(appId: string, entry: AuditEntry): Promise<void> {
    await appendFile(join(this.appDir(appId), 'audit.log'), JSON.stringify(entry) + '\n', 'utf8');
  }
}
