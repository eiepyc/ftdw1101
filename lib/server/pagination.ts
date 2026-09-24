import { AppError } from "./errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UuidCursor = { createdAt: string; id: string };
export type NumericCursor = { createdAt: string; id: number };

export function encodeCursor(createdAt: string, id: string | number): string {
  return Buffer.from(createdAt + "|" + String(id), "utf8").toString("base64url");
}

function decode(value: string): [string, string] {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError(422, "invalid_cursor", "分页位置无效，请从第一页重新打开。");
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new AppError(422, "invalid_cursor", "分页位置无效，请从第一页重新打开。");
  }
  const separator = decoded.lastIndexOf("|");
  if (separator < 1) throw new AppError(422, "invalid_cursor", "分页位置无效，请从第一页重新打开。");
  return [decoded.slice(0, separator), decoded.slice(separator + 1)];
}

export function decodeUuidCursor(value: string | null): UuidCursor | null {
  if (!value) return null;
  const [createdAt, id] = decode(value);
  if (!Number.isFinite(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) {
    throw new AppError(422, "invalid_cursor", "分页位置无效，请从第一页重新打开。");
  }
  return { createdAt, id };
}

export function decodeNumericCursor(value: string | null): NumericCursor | null {
  if (!value) return null;
  const [createdAt, id] = decode(value);
  const numericId = Number(id);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isSafeInteger(numericId) || numericId < 1) {
    throw new AppError(422, "invalid_cursor", "分页位置无效，请从第一页重新打开。");
  }
  return { createdAt, id: numericId };
}

export function requireWeekParam(value: string | null): string {
  if (!value || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    throw new AppError(422, "invalid_week", "周日期无效，请重新选择。");
  }
  return value;
}
