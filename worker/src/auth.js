// Self-contained truck-stock auth: PBKDF2 passwords + HS256 JWT (Web Crypto, no
// deps). Keyed on TS_JWT_SECRET — a DIFFERENT secret from the crm-worker's
// JWT_SECRET — so these tokens verify ONLY on the truck-stock + gp-tracker
// workers and NEVER on the crm-worker (true zero CRM access).

function b64Encode(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64Decode(str) { const bin = atob(str); const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i); return buf; }
function b64UrlEncode(str) { return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64UrlDecode(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return atob(str); }

// PBKDF2-SHA256, 16-byte random salt, 100k iterations -> base64(salt):base64(hash).
// Same format verifyPassword() reads. Used to set tech PINs (and any TS password).
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256);
  return `${b64Encode(salt)}:${b64Encode(bits)}`;
}

// PBKDF2-SHA256, 16-byte salt, 100k iterations -> base64(salt):base64(hash).
export async function verifyPassword(password, storedHash) {
  const [saltB64, hashB64] = (storedHash || "").split(":");
  if (!saltB64 || !hashB64) return false;
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: b64Decode(saltB64), iterations: 100000, hash: "SHA-256" }, km, 256);
  return b64Encode(bits) === hashB64;
}

async function getSigningKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJWT(payload, secret, expiresInSeconds = 1209600) { // 14 days
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const input = `${b64UrlEncode(JSON.stringify(header))}.${b64UrlEncode(JSON.stringify(body))}`;
  const key = await getSigningKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${b64UrlEncode(String.fromCharCode(...new Uint8Array(sig)))}`;
}

export async function verifyJWT(token, secret) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [eh, ep, es] = parts;
  const key = await getSigningKey(secret);
  const sigBytes = Uint8Array.from(b64UrlDecode(es), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${eh}.${ep}`));
  if (!valid) return null;
  const payload = JSON.parse(b64UrlDecode(ep));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;
  return payload;
}

// Read + verify the Bearer token with TS_JWT_SECRET. Returns { account, ... } or null.
export async function authenticate(request, env) {
  const h = request.headers.get("Authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  if (!env.TS_JWT_SECRET) return null;
  return verifyJWT(h.slice(7), env.TS_JWT_SECRET);
}
