import { IngestError, StopRunError } from "./types.ts";

export type Fetch = typeof globalThis.fetch;

export const USER_AGENT = "decompendium-ingest (+https://decompendium.com)";

/** Read a response body, failing as soon as it passes `limit` bytes. */
export async function readLimited(res: Response, limit: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (declared > limit) throw new IngestError(`${what} is ${declared} bytes, over the ${limit}-byte limit`);
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) {
      await res.body.cancel().catch(() => {});
      throw new IngestError(`${what} exceeds the ${limit}-byte limit`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Thin GitHub REST client that counts requests and stops on rate limits. */
export class GitHub {
  requests = 0;
  private readonly fetch: Fetch;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    fetch: Fetch,
    token: string | undefined,
    timeoutMs: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.fetch = fetch;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  /** GET an API path. Returns null for 404 so callers can say what was missing. */
  async get<T>(path: string): Promise<T | null> {
    const res = await this.request(`https://api.github.com${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new IngestError(`GitHub API ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** GET an API path as text (e.g. a raw README), at most `limit` bytes. Null for 404. */
  async getText(path: string, accept: string, limit: number): Promise<string | null> {
    const res = await this.request(`https://api.github.com${path}`, accept);
    if (res.status === 404) return null;
    if (!res.ok) throw new IngestError(`GitHub API ${path}: HTTP ${res.status}`);
    // Keep the first `limit` bytes and stop reading.
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length >= limit) {
        await res.body?.cancel().catch(() => {});
        break;
      }
    }
    return text.slice(0, limit);
  }

  /** GET a URL that GitHub redirects to storage (artifact downloads). */
  async download(path: string, limit: number): Promise<Uint8Array> {
    const res = await this.request(`https://api.github.com${path}`);
    if (!res.ok) throw new IngestError(`GitHub download ${path}: HTTP ${res.status}`);
    return readLimited(res, limit, "artifact");
  }

  /**
   * Waits out short throttles: secondary rate limits (429 or 403 with
   * Retry-After) and per-minute search limits that reset within two minutes.
   * A spent hourly limit stops the run instead.
   */
  private async request(url: string, accept = "application/vnd.github+json"): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.attempt(url, accept);
      const throttled = res.status === 429 || (res.status === 403 && res.headers.has("retry-after"));
      const spent = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
      if (!throttled && !spent) {
        if (res.status === 401) throw new StopRunError("GitHub API rejected the token (HTTP 401)");
        return res;
      }
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      const wait = spent ? reset - Date.now() + 1000 : retryAfter > 0 ? retryAfter : 60_000 * (attempt + 1);
      if (attempt >= 3 || wait > 120_000) {
        if (spent) throw new StopRunError(`GitHub API rate limit reached; resets at ${new Date(reset).toISOString()}`);
        return res; // still throttled: let the caller record the failure
      }
      await res.body?.cancel().catch(() => {});
      await this.sleep(Math.max(wait, 1000));
    }
  }

  private async attempt(url: string, accept: string): Promise<Response> {
    this.requests++;
    const headers: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    // fetch drops the authorization header when the download redirects to another host.
    return this.fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
  }
}
