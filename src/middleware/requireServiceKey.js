const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

/**
 * Protect the evaluation trigger from arbitrary callers. The scheduler sends
 * x-service-key. If INTERNAL_SERVICE_KEY is unset, allow (local/dev) but warn
 * once so the rollout is backward compatible.
 */
let warnedMissingKey = false;
function requireServiceKey(req, res, next) {
  if (!INTERNAL_SERVICE_KEY) {
    if (!warnedMissingKey) {
      console.warn(
        "[Internal] INTERNAL_SERVICE_KEY is not set — /internal/evaluate is open. Set a shared secret in production.",
      );
      warnedMissingKey = true;
    }
    return next();
  }
  const key = req.headers["x-service-key"];
  if (key === INTERNAL_SERVICE_KEY) return next();
  return res.status(401).json({
    success: false,
    error: { code: "UNAUTHORIZED", message: "Valid x-service-key required" },
  });
}

module.exports = requireServiceKey;
