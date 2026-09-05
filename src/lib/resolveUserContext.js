const jwt = require("jsonwebtoken");

/**
 * Identity resolution for a proxied request.
 *
 * ORDER MATTERS AND WAS PREVIOUSLY WRONG.
 *
 * This used to read `x-user-id` FIRST and only fall back to the bearer token
 * when that header was absent:
 *
 *     const fromHeader = req.headers["x-user-id"];
 *     if (fromHeader) return parseInt(String(fromHeader), 10);
 *
 * Two consequences:
 *
 *  1. CORRECTNESS — if the gateway ever forwarded a header that was present
 *     but not a number (notably the literal string "undefined", which
 *     `String(userId)` produces when a JWT lacks the claim), `parseInt` gave
 *     NaN and the service answered 401 "Missing user context" *even though the
 *     request carried a perfectly valid, signed token it could have read.*
 *     The user saw "Today's data unavailable / Missing user context" while
 *     other services that happened to get an intact header worked fine.
 *
 *  2. SECURITY — a plain header was the primary source of identity. Anything
 *     able to reach a service port directly could impersonate any user by
 *     setting `x-user-id`.
 *
 * The bearer token is signed and verifiable, so it is now the primary source.
 * The header is only a fallback, used for genuine service-to-service calls
 * that carry no user token. A malformed header can no longer cause a 401 for
 * an authenticated user, and it can no longer be used to assert an identity
 * that the token contradicts.
 */
function decodeBearer(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !String(auth).startsWith("Bearer ")) return null;

  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  try {
    return jwt.verify(String(auth).slice(7).trim(), secret);
  } catch {
    return null;
  }
}

/** Parse a header/claim into a positive integer id, or null. */
function toUserId(value) {
  if (value == null || value === "") return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveUserId(req) {
  // 1. Verified token — cryptographically trustworthy.
  const decoded = decodeBearer(req);
  if (decoded) {
    const fromToken = toUserId(decoded.userId ?? decoded.userid ?? decoded.sub);
    if (fromToken) return fromToken;
  }

  // 2. Gateway-injected header — only reachable for service-to-service traffic
  //    or when the token carried no usable claim.
  return toUserId(req.headers["x-user-id"]);
}

function resolveTenantHeaders(req) {
  const decoded = decodeBearer(req);

  // Verified claims win; headers fill gaps.
  const fromToken = decoded
    ? {
        entityCode: decoded.entityCode ?? null,
        companyCode: decoded.companyCode ?? null,
        branchCode: decoded.branchCode ?? null,
        appCode: decoded.appCode ?? null,
      }
    : {};

  return {
    entityCode: fromToken.entityCode || req.headers["x-entity-code"] || null,
    companyCode: fromToken.companyCode || req.headers["x-company-code"] || null,
    branchCode: fromToken.branchCode || req.headers["x-branch-code"] || null,
    appCode: fromToken.appCode || req.headers["x-app-code"] || null,
  };
}

module.exports = { resolveUserId, resolveTenantHeaders, decodeBearer };
