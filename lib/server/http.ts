import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError, invalidFields } from "./errors";
import { getServerEnv } from "./env";

export type ApiHandler = (request: NextRequest) => Promise<NextResponse>;
export type ApiContextHandler<C> = (request: NextRequest, context: C) => Promise<NextResponse>;

export function api(handler: ApiHandler): (request: NextRequest) => Promise<NextResponse>;
export function api<C>(handler: ApiContextHandler<C>): (request: NextRequest, context: C) => Promise<NextResponse>;
export function api(handler: ApiHandler | ApiContextHandler<unknown>) {
  return async (request: NextRequest, context?: unknown): Promise<NextResponse> => {
    try {
      return setResponseHeaders(await (handler as ApiContextHandler<unknown>)(request, context));
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
      const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (appError.retryAfter) headers.set("Retry-After", String(appError.retryAfter));
      return NextResponse.json({
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.fieldErrors ? { fields: appError.fieldErrors } : {}),
        },
      }, { status: appError.status, headers });
    }
  };
}

function setResponseHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function json<T>(data: T, init: { status?: number } = {}): NextResponse {
  return NextResponse.json(data, { status: init.status ?? 200, headers: { "Cache-Control": "no-store" } });
}

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  let actual: string;
  try {
    actual = origin ? new URL(origin).origin : "";
  } catch {
    actual = "";
  }
  if (actual !== getServerEnv().appOrigin) {
    throw new AppError(403, "origin_rejected", "请求来源无效，请刷新页面后重试。");
  }
}

export async function readJson<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError(415, "content_type_required", "请求格式必须是 JSON。");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) {
    throw new AppError(413, "body_too_large", "请求内容超过 16 KiB 限制。");
  }
  if (!request.body) throw new AppError(400, "body_required", "请求内容不能为空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > 16_384) {
      await reader.cancel();
      throw new AppError(413, "body_too_large", "请求内容超过 16 KiB 限制。");
    }
    chunks.push(part.value);
  }
  let value: unknown;
  try {
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    value = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new AppError(400, "invalid_json", "请求内容不是有效 JSON。");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length ? String(issue.path[0]) : "form";
      (fields[key] ??= []).push(issue.message);
    }
    throw invalidFields(fields);
  }
  return result.data;
}
