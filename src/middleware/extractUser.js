const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;
const { resolveUserId, resolveTenantHeaders } = require("../lib/resolveUserContext");

const extractUser = (req, res, next) => {
  const serviceKey = req.headers["x-service-key"];

  if (INTERNAL_SERVICE_KEY && serviceKey === INTERNAL_SERVICE_KEY) {
    req.isInternal = true;
    const fallbackId = req.query.userId || req.body?.userId;
    if (fallbackId) req.userId = parseInt(fallbackId, 10);
    return next();
  }

  const userId = resolveUserId(req);
  if (!userId || Number.isNaN(userId)) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing user context" },
    });
  }

  req.userId = userId;
  const tenant = resolveTenantHeaders(req);
  req.entityCode = tenant.entityCode;
  req.companyCode = tenant.companyCode;
  req.branchCode = tenant.branchCode;
  req.appCode = tenant.appCode;
  next();
};

module.exports = extractUser;
