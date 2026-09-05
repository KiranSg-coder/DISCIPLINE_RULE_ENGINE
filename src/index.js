require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const sequelizeConnection = require("./config/database");

/** Listen before DB sync so gateway never hangs on a dead port during boot. */
let dbReady = false;

const corsOrigin =
  process.env.CORS_ORIGIN === "*"
    ? true
    : (process.env.CORS_ORIGIN || "http://localhost:5173")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
app.use(cors({ origin: corsOrigin, credentials: true }));
const internalRoutes = require("./routes/internal.routes");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  if (!dbReady) {
    return res.status(503).json({ status: "starting" });
  }
  return res.status(200).json({ status: "ok" });
});

app.use((req, res, next) => {
  if (dbReady) return next();
  if (req.path === "/healthz") return next();
  if (req.path === "/") {
    return res.send("Discipline rule engine starting.....");
  }
  return res.status(503).json({
    success: false,
    error: {
      code: "SERVICE_STARTING",
      message: "Discipline rule engine is starting. Retry shortly.",
    },
  });
});

app.get("/", (_req, res) => {
  res.send(
    dbReady
      ? "Discipline rule engine running....."
      : "Discipline rule engine starting.....",
  );
});

// Public aliases for browser-facing stats (same handlers as /internal/stats/*).
const statsOnly = require("express").Router();
const extractUser = require("./middleware/extractUser");
const {
  getWeekStats,
  getStreakStats,
  getOverallStats,
  getModeHistory,
  getAchievements,
} = require("./controllers/stats.controller");
statsOnly.get("/week", extractUser, getWeekStats);
statsOnly.get("/streak", extractUser, getStreakStats);
statsOnly.get("/overall", extractUser, getOverallStats);
statsOnly.get("/mode-history", extractUser, getModeHistory);
statsOnly.get("/achievements", extractUser, getAchievements);

app.use("/stats", statsOnly);
app.use("/internal", internalRoutes);

const PORT = process.env.PORT || 6005;

app.listen(PORT, () => {
  console.log(`Discipline listening on port ${PORT} (dbReady=${dbReady})`);
});

sequelizeConnection
  .authenticate()
  .then(() => {
    console.log("Database connection has been established successfully.");
    return sequelizeConnection.sync();
  })
  .then(() => {
    dbReady = true;
    console.log(`Discipline ready on port ${PORT}`);
  })
  .catch((err) => {
    console.error("Error occured while syncing database: ", err);
  });

module.exports = app;
