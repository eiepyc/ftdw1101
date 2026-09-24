"use client";

export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string[]>;

  constructor(message: string, code: string, status: number, fields?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("服务暂时不可用，请稍后重试。", "invalid_response", response.status);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; fields?: Record<string, string[]> } }).error;
    throw new ApiError(error?.message ?? "操作失败，请稍后重试。", error?.code ?? "request_failed", response.status, error?.fields);
  }
  return payload as T;
}

export function postJson<T>(path: string, value: unknown, method = "POST"): Promise<T> {
  return apiRequest<T>(path, { method, body: JSON.stringify(value) });
}
