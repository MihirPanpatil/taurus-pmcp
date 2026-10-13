import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApprovalHandler, ApprovalRequest } from './runtime.js';

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export type ApprovalEvent = { type: 'requested' | 'approved' | 'denied' | 'expired'; approval: PendingApproval };

interface Waiting {
  approval: PendingApproval;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds tool calls that need the user's confirmation until someone decides in the monitor, or the request expires.
 * The default timeout stays under common MCP client request timeouts (60 s), so the agent gets a clear
 * `approval_required` answer instead of a dropped connection.
 */
export class ApprovalBroker extends EventEmitter<{ approval: [ApprovalEvent] }> {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly timeoutMs = 50_000) {
    super();
  }

  /** Pass this as the runtime's `approve` option. */
  readonly handler: ApprovalHandler = (request) => this.request(request);

  request(request: ApprovalRequest): Promise<boolean> {
    const now = Date.now();
    const approval: PendingApproval = {
      ...request,
      id: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(approval.id, false, 'expired'), this.timeoutMs);
      this.waiting.set(approval.id, { approval, resolve, timer });
      this.emit('approval', { type: 'requested', approval });
    });
  }

  /** Returns false if the request no longer exists, e.g. it expired. */
  decide(id: string, approved: boolean): boolean {
    return this.settle(id, approved, approved ? 'approved' : 'denied');
  }

  list(): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval);
  }

  private settle(id: string, approved: boolean, type: ApprovalEvent['type']): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    this.waiting.delete(id);
    waiting.resolve(approved);
    this.emit('approval', { type, approval: waiting.approval });
    return true;
  }
}
