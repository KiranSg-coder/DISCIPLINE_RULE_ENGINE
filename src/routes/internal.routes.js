const express = require("express");
const router = express.Router();
const extractUser = require("../middleware/extractUser");
const { evaluateDay } = require("../controllers/evaluation.controller");
const { getWeekStats, getStreakStats, getOverallStats, getModeHistory } = require("../controllers/stats.controller");

router.post("/evaluate", evaluateDay);

router.get("/stats/week", extractUser, getWeekStats);
router.get("/stats/streak", extractUser, getStreakStats);
router.get("/stats/overall", extractUser, getOverallStats);
router.get("/stats/mode-history", extractUser, getModeHistory);

module.exports = router;