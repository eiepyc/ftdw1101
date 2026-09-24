export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryAfter?: number; fieldErrors?: Record<string, string[]> } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.fieldErrors = options.fieldErrors;
  }
}

export function fromDatabaseError(code: string | undefined, message: string): AppError {
  if (message.toLowerCase().includes("device account quota")) {
    return new AppError(409, "device_limit", "此浏览器已达到两个账号的注册上限。");
  }
  if (message.toLowerCase().includes("duplicate key")) {
    return new AppError(409, "conflict", "该用户名已被占用，或这条登记已存在。");
  }
  switch (code) {
    case "28000":
      return new AppError(401, "unauthenticated", "登录状态已失效，请重新登录。");
    case "42501":
      return new AppError(403, "forbidden", "没有权限执行此操作。");
    case "22023":
      return new AppError(422, "invalid_request", "提交内容无效或超出允许范围。");
    case "23505":
    case "23514":
    case "40001":
      return new AppError(409, "conflict", "当前状态已变化，请刷新后重试。");
    case "P0002":
      return new AppError(404, "not_found", "找不到这条记录。");
    default:
      return new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试。");
  }
}

export function invalidFields(fieldErrors: Record<string, string[]>): AppError {
  return new AppError(422, "validation_failed", "请检查标记的输入项。", { fieldErrors });
}
