const express = require("express");
const router = express.Router();
const extractUser = require("../middleware/extractUser");
const requireServiceKey = require("../middleware/requireServiceKey");
const {
  evaluateDay,
  awardAchievements,
} = require("../controllers/evaluation.controller");
const {
  getWeekStats,
  getStreakStats,
  getOverallStats,
  getModeHistory,
  getAchievements,
} = require("../controllers/stats.controller");

router.post("/evaluate", requireServiceKey, evaluateDay);
router.post("/achievements/award", requireServiceKey, awardAchievements);

router.get("/stats/week", extractUser, getWeekStats);
router.get("/stats/streak", extractUser, getStreakStats);
router.get("/stats/overall", extractUser, getOverallStats);
router.get("/stats/mode-history", extractUser, getModeHistory);
router.get("/stats/achievements", extractUser, getAchievements);

module.exports = router;
