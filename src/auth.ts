export type SessionInfo = {
  authenticated: boolean;
  authRequired: boolean;
};

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
}

export async function fetchSession(): Promise<SessionInfo> {
  const r = await apiFetch("/api/auth/session");
  const j = (await r.json()) as Partial<SessionInfo>;
  return {
    authenticated: Boolean(j.authenticated),
    authRequired: Boolean(j.authRequired),
  };
}

export async function login(username: string, password: string): Promise<string | null> {
  const r = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = (await r.json()) as { error?: string };
  if (!r.ok) return j.error ?? "Invalid username or password";
  return null;
}

export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}
