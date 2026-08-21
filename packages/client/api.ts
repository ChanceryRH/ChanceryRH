/** Minimal frontend transport; no provider secrets, treasury signing, or UI dependencies. */
export class ChanceryError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export class ChanceryClient {
  baseUrl: string;
  csrfToken: string | null = null;
  onSessionExpired?: () => void;
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  async request<T = any>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    refreshed = false,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.csrfToken ? { "X-CSRF-Token": this.csrfToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined as T;
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new ChanceryError(
        "Chancery returned an unreadable response. Try again shortly.",
        "response_invalid",
        response.status,
      );
    }
    if (response.status === 401 && data.error?.code === "sign_in_required") {
      this.csrfToken = null;
      this.onSessionExpired?.();
    }
    // A rejected CSRF check occurs before any protected action. Refresh only this
    // known preflight failure; never automatically retry a provider or transaction request.
    if (
      response.status === 403 &&
      data.error?.code === "csrf_invalid" &&
      !refreshed
    ) {
      await this.session();
      return this.request<T>(path, body, method, true);
    }
    if (!response.ok)
      throw new ChanceryError(
        data.error?.message || "Request failed",
        data.error?.code || "request_failed",
        response.status,
      );
    if (data.csrfToken) this.csrfToken = data.csrfToken;
    return data;
  }
  session() {
    return this.request("/auth/session");
  }
  walletChallenge(address: string) {
    return this.request("/auth/wallet/challenge", { address });
  }
  walletVerify(challengeId: string, signature: string) {
    return this.request("/auth/wallet/verify", { challengeId, signature });
  }
  logout() {
    return this.request("/auth/logout", {});
  }
  office(id: string, path = "", body?: unknown) {
    return this.request(`/offices/${encodeURIComponent(id)}${path}`, body);
  }
}
