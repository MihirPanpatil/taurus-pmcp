import type { WebContents } from 'electron';
import { ShapeAggregator } from '@taurus/core';

interface Pending {
  method: string;
  url: string;
  postData?: string;
  hasPostData?: boolean;
  status?: number;
  mimeType?: string;
}

interface CdpRequestWillBeSent {
  requestId: string;
  type?: string;
  request: { method: string; url: string; postData?: string; hasPostData?: boolean };
}

const isJsonMime = (mime?: string) => !!mime && /json/i.test(mime);

/**
 * Watches an app page's fetch/XHR traffic through the DevTools protocol and hands each exchange to a ShapeAggregator,
 * which keeps shapes only. Bodies are parsed here and dropped immediately.
 */
export class NetworkCapture {
  readonly aggregator: ShapeAggregator;
  private readonly pending = new Map<string, Pending>();
  private inFlight = 0;
  private lastActivity = Date.now();

  constructor(
    private readonly contents: WebContents,
    origin: string,
    /** Called for requests that are seen but not kept, with the reason. */
    private readonly onSkip?: (reason: string, method: string, url: string) => void,
  ) {
    this.aggregator = new ShapeAggregator(origin);
  }

  async start(): Promise<void> {
    const dbg = this.contents.debugger;
    dbg.attach('1.3');
    dbg.on('message', (_event, method, params) => {
      void this.onMessage(method, params as Record<string, unknown>);
    });
    await dbg.sendCommand('Network.enable', { maxPostDataSize: 65_536 });
  }

  stop(): void {
    try {
      this.contents.debugger.detach();
    } catch {
      // already detached, e.g. the window was closed
    }
  }

  /** Resolves once no request has been in flight for `quietMs`, or after `timeoutMs`. */
  async idle(quietMs = 500, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.inFlight <= 0 && Date.now() - this.lastActivity >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private async onMessage(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'Network.requestWillBeSent') {
      const event = params as unknown as CdpRequestWillBeSent;
      if (event.type !== 'Fetch' && event.type !== 'XHR') return;
      this.pending.set(event.requestId, {
        method: event.request.method,
        url: event.request.url,
        postData: event.request.postData,
        hasPostData: event.request.hasPostData,
      });
      this.inFlight++;
      this.touch();
    } else if (method === 'Network.responseReceived') {
      const pending = this.pending.get(params.requestId as string);
      const response = params.response as { status: number; mimeType?: string };
      if (pending) {
        pending.status = response.status;
        pending.mimeType = response.mimeType;
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const requestId = params.requestId as string;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      try {
        // Chromium reports a body-less response the page never reads (e.g. 204) as ERR_ABORTED even though the
        // server answered, so anything that already has a status still counts as a completed exchange.
        if (method === 'Network.loadingFinished' || pending.status !== undefined) await this.finish(requestId, pending);
        else this.onSkip?.(`failed: ${String(params.errorText ?? 'unknown error')}`, pending.method, pending.url);
      } finally {
        this.inFlight--;
        this.touch();
      }
    }
  }

  private async finish(requestId: string, pending: Pending): Promise<void> {
    const dbg = this.contents.debugger;
    let responseBody: unknown;
    if (isJsonMime(pending.mimeType)) {
      try {
        const result = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as { body: string; base64Encoded: boolean };
        const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
        responseBody = text ? JSON.parse(text) : undefined;
      } catch {
        // not JSON after all, or the body is gone
      }
    }
    let postData = pending.postData;
    if (!postData && pending.hasPostData) {
      try {
        postData = ((await dbg.sendCommand('Network.getRequestPostData', { requestId })) as { postData: string }).postData;
      } catch {
        // body not available
      }
    }
    let requestBody: unknown;
    if (postData) {
      try {
        requestBody = JSON.parse(postData);
      } catch {
        // not JSON
      }
    }
    const looksLikeApi =
      isJsonMime(pending.mimeType) || responseBody !== undefined || requestBody !== undefined || pending.status === 204;
    if (!looksLikeApi) {
      this.onSkip?.(`not an API exchange (status ${pending.status ?? 'none'}, type ${pending.mimeType || 'none'})`, pending.method, pending.url);
      return;
    }
    this.aggregator.add({
      method: pending.method,
      url: pending.url,
      status: pending.status ?? 0,
      contentType: pending.mimeType || undefined,
      requestBody,
      responseBody,
    });
  }
}
