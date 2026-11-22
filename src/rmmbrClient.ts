const defaultTimeoutMs = 1000;
const defaultMaxInMemKeys = 100;

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const callRmmbrApi = async (
  url: string,
  token: string,
  method: "get" | "set",
  params: Record<string, unknown>,
): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(defaultTimeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `rmmbr ${method} HTTP ${response.status} ${response.statusText}${
        text ? `: ${text.slice(0, 200)}` : ""
      }`,
    );
  }
  return JSON.parse(text);
};

export type CloudCacheParams<Args extends unknown[]> = {
  cacheId: string;
  ttl?: number;
  url: string;
  token: string;
  customKeyFn: (...args: Args) => string;
};

export const cache = <Args extends unknown[]>({
  cacheId,
  ttl,
  url,
  token,
  customKeyFn,
}: CloudCacheParams<Args>) =>
<Result>(
  f: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> => {
  const inMemory = new Map<string, Promise<Result>>();
  const inFlight = new Map<string, Promise<Result>>();

  const remember = (key: string, promise: Promise<Result>) => {
    inMemory.delete(key);
    inMemory.set(key, promise);
    if (inMemory.size > defaultMaxInMemKeys) {
      const oldest = inMemory.keys().next().value;
      if (oldest !== undefined) inMemory.delete(oldest);
    }
  };

  return async (...args: Args): Promise<Result> => {
    const key = await sha256Hex(JSON.stringify(customKeyFn(...args)));
    const memHit = inMemory.get(key);
    if (memHit) {
      inMemory.delete(key);
      inMemory.set(key, memHit);
      return memHit;
    }
    const flightHit = inFlight.get(key);
    if (flightHit) return flightHit;

    const promise = callRmmbrApi(url, token, "get", { key, cacheId })
      .then((value) => {
        if (!value) throw new Error("cache miss");
        return value as Result;
      })
      .catch(async () => {
        const result = await f(...args);
        callRmmbrApi(url, token, "set", { key, value: result, ttl, cacheId })
          .catch((e) => console.error("failed writing to rmmbr cache", e));
        return result;
      })
      .then((value) => {
        remember(key, Promise.resolve(value));
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };
};
