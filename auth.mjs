import crypto from "node:crypto";

export const SESSION_COOKIE = "canteen_session";
const SESSION_MAX_AGE_MS = Number(process.env.AUTH_SESSION_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000);

const USERNAME = (process.env.SITE_USERNAME ?? "admin").trim();
const PASSWORD = (process.env.SITE_PASSWORD ?? "").trim();

export function isAuthEnabled() {
  return PASSWORD.length > 0;
}

function authSecret() {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (isAuthEnabled()) {
    console.warn(
      "AUTH_SECRET is not set. Using a development default — set AUTH_SECRET in .env before production.",
    );
    return "canteen-dev-insecure-secret";
  }
  return "";
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", authSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function createSessionToken(username) {
  const now = Date.now();
  const sub = String(username ?? USERNAME).trim() || USERNAME;
  return signPayload({ sub, iat: now, exp: now + SESSION_MAX_AGE_MS });
}

/** @returns {{ sub?: string; iat: number; exp: number } | null} */
export function getSessionPayload(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", authSecret()).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

export function verifySessionToken(token) {
  return getSessionPayload(token) != null;
}

/** @returns {{ username: string } | null} */
export function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const payload = getSessionPayload(token);
  if (!payload) return null;
  const username =
    typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : USERNAME;
  return { username };
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header || typeof header !== "string") return {};
  const out = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function cookieSecure() {
  return process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
}

export function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
  ];
  if (cookieSecure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (cookieSecure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function isAuthenticated(req) {
  if (!isAuthEnabled()) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  return verifySessionToken(token);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function validateCredentials(username, password) {
  return safeEqual(username, USERNAME) && safeEqual(password, PASSWORD);
}

/** Block /api/* except /api/auth/* when SITE_PASSWORD is set. */
export function protectApiRoutes(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (req.path.startsWith("/api/auth/")) return next();
  if (!isAuthEnabled()) return next();
  if (isAuthenticated(req)) return next();
  res.status(401).json({
    error: "Authentication required",
    hint: "Log in to access this dashboard.",
  });
}
