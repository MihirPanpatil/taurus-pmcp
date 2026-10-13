export interface RateLimiterOptions {
  /** Burst size per site. */
  capacity: number;
  /** Sustained requests per second per site. */
  refillPerSecond: number;
  /** Give up and return `rate_limited` instead of waiting longer than this. */
  maxWaitMs: number;
}

/** Third-party websites. */
export const DEFAULT_RATE_LIMITS: RateLimiterOptions = { capacity: 5, refillPerSecond: 1, maxWaitMs: 15_000 };

/** Apps on this machine or the local network: your own devices and self-hosted apps (WATCH.md 6.1). */
export const LOCAL_RATE_LIMITS: RateLimiterOptions = { capacity: 20, refillPerSecond: 10, maxWaitMs: 15_000 };

const PRIVATE_HOST =
  /^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[^.]+\.(localhost|local|test|internal|lan|home\.arpa))$/i;

/** Picks limits by where the site lives. Keys are origins. */
export function limitsForOrigin(origin: string): RateLimiterOptions {
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname) ? LOCAL_RATE_LIMITS : DEFAULT_RATE_LIMITS;
  } catch {
    return DEFAULT_RATE_LIMITS;
  }
}

interface Bucket {
  tokens: number;
  last: number;
  blockedUntil: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One token bucket per site, shared by every tool, agent and workflow (ARCHITECTURE section 8). */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  private readonly limits: (key: string) => RateLimiterOptions;

  /** Pass fixed options, or a function that picks options per key (default: by origin). */
  constructor(options: RateLimiterOptions | ((key: string) => RateLimiterOptions) = limitsForOrigin) {
    this.limits = typeof options === 'function' ? options : () => options;
  }

  private bucket(key: string): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.limits(key).capacity, last: Date.now(), blockedUntil: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Resolves true once a request may be sent, or false if that would take longer than `maxWaitMs`. */
  async acquire(key: string): Promise<boolean> {
    const limits = this.limits(key);
    const deadline = Date.now() + limits.maxWaitMs;
    for (;;) {
      const bucket = this.bucket(key);
      const now = Date.now();
      bucket.tokens = Math.min(limits.capacity, bucket.tokens + ((now - bucket.last) / 1000) * limits.refillPerSecond);
      bucket.last = now;
      let wait: number;
      if (bucket.blockedUntil > now) wait = bucket.blockedUntil - now;
      else if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
      } else wait = ((1 - bucket.tokens) / limits.refillPerSecond) * 1000;
      if (now + wait > deadline) return false;
      await sleep(Math.ceil(wait));
    }
  }

  /** Blocks a site after it answered 429, honoring its Retry-After. */
  penalize(key: string, ms: number): void {
    const bucket = this.bucket(key);
    bucket.blockedUntil = Math.max(bucket.blockedUntil, Date.now() + ms);
    bucket.tokens = 0;
  }

  /** Milliseconds until the site accepts requests again, for `retryAfter` in errors. */
  blockedFor(key: string): number {
    return Math.max(0, this.bucket(key).blockedUntil - Date.now());
  }
}
