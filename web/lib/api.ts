// API クライアント。金額・権限・定員・状態遷移・割引の判定はすべてサーバー側で行う。
// 画面側は表示とユーザー入力の受け渡しだけを担当する。

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

type Options = {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export async function api<T = any>(method: string, path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "fetch" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "通信できませんでした。電波の良い場所で再度お試しください");
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `エラーが発生しました（${res.status}）`, err?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string, signal?: AbortSignal) => api<T>("GET", path, { signal });
export const post = <T = any>(path: string, body?: unknown, idempotencyKey?: string) =>
  api<T>("POST", path, { body: body ?? {}, idempotencyKey });
export const patch = <T = any>(path: string, body: unknown) => api<T>("PATCH", path, { body });
export const put = <T = any>(path: string, body: unknown) => api<T>("PUT", path, { body });

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "エラーが発生しました";
}
