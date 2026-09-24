import "server-only";
import { AppError } from "./errors";
import { createRequestAuthClient, getServiceClient, rpc } from "./db";
import { issueAppSession } from "./session";

type AuthIdentity = { user_id: string; auth_email: string; auth_epoch: number };
type AuthIdentityRow = AuthIdentity;

function isDuplicateAccount(message: string): boolean {
  const value = message.toLowerCase();
  return value.includes("email_exists") || value.includes("already registered") || value.includes("already exists") || value.includes("duplicate key");
}

export async function registerAccount(username: string, password: string, deviceHash: string): Promise<void> {
  const registrations = await rpc<number>("app_device_registrations", { p_device_hash: deviceHash });
  if (registrations >= 2) throw new AppError(409, "device_limit", "此浏览器已达到两个账号的注册上限。");

  const { data, error } = await getServiceClient().auth.admin.createUser({
    email: username + "@team-slots.local",
    password,
    email_confirm: true,
    app_metadata: { username, device_hash: deviceHash },
  });

  if (error || !data.user) {
    const status = error?.status ?? 500;
    if (error && isDuplicateAccount(error.message)) {
      throw new AppError(409, "username_taken", "这个用户名已被使用。");
    }
    if (error && status >= 400 && status < 500) {
      if (status === 429) throw new AppError(429, "auth_rate_limited", "认证服务暂时限制了注册，请稍后重试。", { retryAfter: 60 });
      throw new AppError(422, "registration_rejected", "注册未完成，请检查密码长度并重试。");
    }
    if (status === 500) {
      try {
        const currentCount = await rpc<number>("app_device_registrations", { p_device_hash: deviceHash });
        if (currentCount >= 2) throw new AppError(409, "device_limit", "此浏览器已达到两个账号的注册上限。");
      } catch (quotaError) {
        if (quotaError instanceof AppError && quotaError.code === "device_limit") throw quotaError;
      }
    }
    throw new AppError(503, "registration_uncertain", "注册结果暂时无法确认。请先尝试用该用户名登录，再决定是否重试。");
  }

  try {
    const identity = (await rpc<AuthIdentity[]>("app_auth_identity", { p_username: username }))[0];
    if (!identity || identity.user_id !== data.user.id) throw new Error("registration profile unavailable");
    await issueAppSession(data.user.id, 0);
  } catch {
    throw new AppError(503, "account_created_sign_in", "账号已创建，但暂时无法建立登录状态。请从登录入口重新登录。");
  }
}

export async function loginWithPassword(username: string, password: string): Promise<void> {
  const identity = (await rpc<AuthIdentityRow[]>("app_auth_identity", { p_username: username }))[0];
  if (!identity) throw new AppError(401, "invalid_credentials", "用户名或密码不正确，或账号暂不可用。");

  const authClient = createRequestAuthClient();
  const { data, error } = await authClient.auth.signInWithPassword({
    email: identity.auth_email,
    password,
  });
  const status = error?.status ?? 500;
  if (error && (status >= 500 || status <= 0)) {
    throw new AppError(503, "auth_unavailable", "认证服务暂时不可用，请稍后重试。");
  }
  if (error && status === 429) {
    throw new AppError(429, "auth_rate_limited", "认证服务暂时限制了登录，请稍后重试。", { retryAfter: 60 });
  }
  if (error || !data.user || data.user.id !== identity.user_id) {
    throw new AppError(401, "invalid_credentials", "用户名或密码不正确，或账号暂不可用。");
  }

  try {
    await issueAppSession(identity.user_id, identity.auth_epoch);
  } catch (sessionError) {
    if (sessionError instanceof AppError && sessionError.status !== 401) throw sessionError;
    throw new AppError(401, "invalid_credentials", "用户名或密码不正确，或账号暂不可用。");
  }
}

export type PasswordChangeOutcome = "changed" | "rejected" | "unknown";

export async function updateAuthPassword(userId: string, password: string): Promise<PasswordChangeOutcome> {
  try {
    const { error } = await getServiceClient().auth.admin.updateUserById(userId, { password });
    if (!error) return "changed";
    const status = error.status ?? 500;
    if (status >= 400 && status < 500) return "rejected";
    return "unknown";
  } catch {
    return "unknown";
  }
}
