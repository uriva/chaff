const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null;

const getDenoEnv = (key: string): string | undefined => {
  const g: unknown = globalThis;
  if (!isObject(g) || !isObject(g.Deno) || !isObject(g.Deno.env)) {
    return undefined;
  }
  const get = g.Deno.env.get;
  return typeof get === "function" ? get.call(g.Deno.env, key) : undefined;
};

const getProcessEnv = (key: string): string | undefined => {
  const g: unknown = globalThis;
  if (!isObject(g) || !isObject(g.process) || !isObject(g.process.env)) {
    return undefined;
  }
  const val = g.process.env[key];
  return typeof val === "string" ? val : undefined;
};

export const getEnv = (key: string): string | undefined =>
  getDenoEnv(key) ?? getProcessEnv(key);

const base64ChunkSize = 0x8000;

export const encodeBase64 = (
  data: ArrayBuffer | Uint8Array | string,
): string => {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array
    ? data
    : new Uint8Array(data);
  const chunkCount = Math.ceil(bytes.length / base64ChunkSize);
  const binary = Array.from(
    { length: chunkCount },
    (_, i) =>
      String.fromCharCode(
        ...bytes.subarray(i * base64ChunkSize, (i + 1) * base64ChunkSize),
      ),
  ).join("");
  return btoa(binary);
};

export const decodeBase64 = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
