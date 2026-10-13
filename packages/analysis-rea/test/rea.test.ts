import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reaSource, toFindings } from '@taurus/analysis-rea';
import { silentLogger } from '@taurus/core';

const sample = (name: string) => JSON.parse(readFileSync(new URL(`./samples/${name}`, import.meta.url), 'utf8'));
const ORIGIN = 'http://127.0.0.1:52093';

describe('toFindings with real REA output', () => {
  // Captured from REA 6.3.0 against fixtures/todo-app, which has one fetch() only reachable from an unused button,
  // and one WebMCP registerTool() call.
  const findings = toFindings(ORIGIN, sample('analyze-web-bundle.json'), sample('discover-webmcp-tools.json'), '6.3.0');

  it('keeps the endpoint found in code as a template without a guessed method', () => {
    expect(findings.endpoints).toEqual([{ pathTemplate: '/api/stats', pathParams: [], queryParams: [], mechanism: 'call:fetch' }]);
  });

  it('records the page-declared WebMCP tool as untrusted', () => {
    expect(findings.declaredTools).toEqual([
      {
        name: 'count_open_tasks',
        description: 'Count the open tasks in the selected project.',
        inputProperties: [],
        mechanism: 'webmcp-static',
        trust: 'page-declared-untrusted',
      },
    ]);
  });

  it('carries REA limitations through', () => {
    expect(findings.limitations.some((l) => l.includes('String-built routes'))).toBe(true);
    expect(findings.sourceVersion).toBe('6.3.0');
  });
});

describe('toFindings reduction rules', () => {
  const bundle = (endpoints: { value: string; mechanism: string }[], webmcp: unknown[] = []) => ({
    normalized_result: { observations: { endpoints, webmcp_declarations: webmcp } },
  });

  it('drops literal IDs, query values and other origins', () => {
    const findings = toFindings(
      ORIGIN,
      bundle([
        { value: '/api/tasks/12345?token=secret-value&page=2', mechanism: 'call:fetch' },
        { value: 'https://tracker.example/collect', mechanism: 'call:fetch' },
        { value: `${ORIGIN}/api/projects`, mechanism: 'call:axios.post' },
      ]),
      null,
    );
    expect(findings.endpoints).toEqual([
      { pathTemplate: '/api/projects', pathParams: [], queryParams: [], method: 'POST', mechanism: 'call:axios.post' },
      { pathTemplate: '/api/tasks/{taskId}', pathParams: ['taskId'], queryParams: ['page', 'token'], mechanism: 'call:fetch' },
    ]);
    const dump = JSON.stringify(findings);
    expect(dump).not.toContain('secret-value');
    expect(dump).not.toContain('12345');
    expect(dump).not.toContain('tracker.example');
  });

  it('ignores WebSocket and loadURL findings', () => {
    const findings = toFindings(ORIGIN, bundle([{ value: '/socket', mechanism: 'call:WebSocket' }, { value: '/x', mechanism: 'call:win.loadURL' }]), null);
    expect(findings.endpoints).toEqual([]);
  });

  it('cleans and caps page-declared text', () => {
    const findings = toFindings(ORIGIN, bundle([], [{ name: 'evil\u0000tool\nname', description: 'x'.repeat(1000), schema_property_names: ['a'] }]), null);
    expect(findings.declaredTools[0].name).toBe('evil tool name');
    expect(findings.declaredTools[0].description).toHaveLength(300);
  });
});

describe('reaSource', () => {
  const target = { origin: ORIGIN, cdpEndpoint: 'http://127.0.0.1:9334', targetId: 'E45C9DE5B58AD00547AD2E4F7C942B03' };

  it('reports when REA is not installed, and refuses to analyze', async () => {
    const source = reaSource({ run: async () => Promise.reject(new Error('not found')) });
    expect((await source.available()).ok).toBe(false);
    await expect(source.analyze(target, silentLogger)).rejects.toThrow('REA is not available');
  });

  it('only attaches to loopback CDP and well-formed targets', async () => {
    const calls: string[][] = [];
    const source = reaSource({
      run: async (args) => {
        calls.push(args);
        return args[0] === '--version' ? '6.3.0\n' : '{}';
      },
    });
    await expect(source.analyze({ ...target, cdpEndpoint: 'http://192.168.1.5:9222' }, silentLogger)).rejects.toThrow('loopback');
    await expect(source.analyze({ ...target, targetId: 'abc & del *' }, silentLogger)).rejects.toThrow('target id');
    expect(calls).toEqual([]);
  });

  it('runs both REA commands without fetching source maps', async () => {
    const calls: string[][] = [];
    const source = reaSource({
      run: async (args) => {
        calls.push(args);
        if (args[0] === '--version') return '6.3.0\n';
        return JSON.stringify(args[0] === 'analyze-web-bundle' ? sample('analyze-web-bundle.json') : sample('discover-webmcp-tools.json'));
      },
    });
    const findings = await source.analyze(target, silentLogger);
    expect(calls.map((c) => c[0])).toEqual(['--version', 'analyze-web-bundle', 'discover-webmcp-tools']);
    expect(calls.flat()).not.toContain('--fetch-source-maps');
    expect(findings.endpoints).toHaveLength(1);
  });
});
