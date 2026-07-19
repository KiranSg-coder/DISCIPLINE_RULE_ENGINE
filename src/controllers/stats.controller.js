const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");

const getWeekStats = async (req, res) => {
  try {
    const userId = req.userId;
    const { startDate } = req.query;

    if (!startDate) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_START_DATE",
          message: "startDate is required (format: YYYY-MM-DD)",
        },
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_DATE_FORMAT",
          message: "startDate must be in YYYY-MM-DD format",
        },
      });
    }

    console.log(
      `[Rule Engine] Fetching week stats for user ${userId}, week starting ${startDate}`,
    );

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_WEEK_STATISTICS
          @USERID = :userId,
          @WEEKSTARTDATE = :weekStartDate`,
      {
        replacements: {
          userId,
          weekStartDate: startDate,
        },
        type: QueryTypes.RAW,
      },
    );

    //=================================================
    // PARSE RESULT SETS
    // [0] - Week summary
    // [1] - Daily breakdown
    // [2] - Domain performance
    // [3] - Pattern string
    //=================================================

    console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE FLAT RESULT SET
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No data found for user ${userId} in week starting ${startDate}`,
        },
      });
    }

    // 1️⃣ Week summary row (has WeekStartDate)
    const summaryData = rows.find((r) => r.WeekStartDate !== undefined);

    // 2️⃣ Daily breakdown rows (have Date + Result)
    const dailyData = rows.filter(
      (r) => r.Date !== undefined && r.Result !== undefined,
    );

    // 3️⃣ Domain performance rows (have DomainType + DomainEmoji)
    const domainData = rows.filter(
      (r) => r.DomainType !== undefined && r.DomainEmoji !== undefined,
    );

    // 4️⃣ Pattern row
    const patternData = rows.find((r) => r.Pattern !== undefined);

    //=================================================
    // CHECK FOR ERRORS
    //=================================================
    if (summaryData && summaryData.ErrorCode) {
      return res.status(404).json({
        success: false,
        error: {
          code: summaryData.ErrorType || "USER_NOT_FOUND",
          message: summaryData.ErrorMessage,
          details: {
            userId: summaryData.UserId,
          },
        },
      });
    }

    if (!summaryData) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No data found for user ${userId} in week starting ${startDate}`,
        },
      });
    }

    //=================================================
    // BUILD DAILY BREAKDOWN
    //=================================================
    const dailyBreakdown = dailyData.map((day) => {
      const isPass = day.Result === "PASS";
      const dayInfo = {
        date: day.Date,
        dayNumber: day.DayNumber,
        result: day.Result,
        status: isPass ? "PASS" : "INCOMPLETE",
        mode: day.Mode,
        completionRate: parseFloat(day.CompletionRate),
        completed: day.Completed,
        total: day.Total,
      };

      // Add missed domains if failed
      if (day.Result === "FAIL" && day.MissedDomains) {
        dayInfo.missedDomains = day.MissedDomains.split(",");
      }

      return dayInfo;
    });

    //=================================================
    // BUILD DOMAIN PERFORMANCE
    //=================================================
    const domainPerformance = domainData.map((domain) => ({
      domainType: domain.DomainType,
      emoji: domain.DomainEmoji || getEmojiForDomain(domain.DomainType),
      completed: domain.Completed,
      total: domain.Total,
      completionRate: parseFloat(domain.CompletionRate),
    }));

    //=================================================
    // MVP WEEKLY FIELDS: Most missed + Always completed
    // We approximate "rule" using domain-level completion from USP_GET_WEEK_STATISTICS.
    //=================================================
    const domainMissedStats = domainPerformance.map((d) => ({
      domainType: d.domainType,
      emoji: d.emoji,
      missedCount: (d.total || 0) - (d.completed || 0),
      total: d.total || 0,
      completed: d.completed || 0,
      completionRate: d.completionRate,
    }));

    const mostMissed = domainMissedStats
      .slice()
      .sort((a, b) => b.missedCount - a.missedCount)[0];

    const alwaysCompleted = domainMissedStats
      .filter((d) => d.missedCount === 0)
      .slice()
      .sort((a, b) => b.total - a.total)[0];

    //=================================================
    // GENERATE INSIGHTS
    //=================================================
    const insights = generateInsights(
      summaryData,
      dailyBreakdown,
      domainPerformance,
    );

    //=================================================
    // BUILD RESPONSE
    //=================================================
    const responseData = {
      userId: summaryData.UserId,
      weekStartDate: summaryData.WeekStartDate,
      weekEndDate: summaryData.WeekEndDate,
      summary: {
        totalDays: summaryData.TotalDays,
        passedDays: summaryData.PassedDays,
        failedDays: summaryData.FailedDays,
        successRate: parseFloat(summaryData.SuccessRate.toFixed(2)),
        currentStreak: summaryData.CurrentStreak,
      },
      dailyBreakdown,
      domainPerformance,
      mostMissedRule: mostMissed
        ? {
            domainType: mostMissed.domainType,
            emoji: mostMissed.emoji,
            missedCount: mostMissed.missedCount,
          }
        : null,
      alwaysCompletedRule: alwaysCompleted
        ? {
            domainType: alwaysCompleted.domainType,
            emoji: alwaysCompleted.emoji,
            completedCount: alwaysCompleted.completed,
            totalCount: alwaysCompleted.total,
          }
        : null,
      pattern: patternData?.Pattern || "",
      insights,
    };

    console.log(
      `[Rule Engine] ✓ Week stats retrieved: ${summaryData.PassedDays}/${summaryData.TotalDays} passed`,
    );

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[Rule Engine] Error fetching week stats:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch week statistics",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

// Helper: Generate insights from data
function generateInsights(summary, dailyBreakdown, domainPerformance) {
  const insights = [];

  // Perfect domains
  const perfectDomains = domainPerformance.filter(
    (d) => d.completionRate === 100.0,
  );
  if (perfectDomains.length > 0) {
    perfectDomains.forEach((domain) => {
      insights.push({
        type: "STRENGTH",
        message: `Perfect on ${domain.domainType} all week`,
      });
    });
  }

  // Weak domains
  const weakDomains = domainPerformance
    .filter((d) => d.completionRate < 80.0)
    .sort((a, b) => a.completionRate - b.completionRate);

  if (weakDomains.length > 0) {
    const weakestDomains = weakDomains.slice(0, 2);
    if (weakestDomains.length === 1) {
      insights.push({
        type: "WEAKNESS",
        message: `${weakestDomains[0].domainType} needs attention (${weakestDomains[0].completionRate.toFixed(0)}%)`,
      });
    } else {
      const domainNames = weakestDomains.map((d) => d.domainType).join(" and ");
      insights.push({
        type: "WEAKNESS",
        message: `${domainNames} missed most often`,
      });
    }
  }

  // Consistency check
  if (summary.successRate >= 85.0) {
    insights.push({
      type: "STRENGTH",
      message: `Strong consistency this week (${summary.successRate.toFixed(0)}%)`,
    });
  }

  // Recent trend
  if (dailyBreakdown.length >= 3) {
    const lastThree = dailyBreakdown.slice(-3);
    const lastThreePasses = lastThree.filter((d) => d.result === "PASS").length;

    if (lastThreePasses === 3) {
      insights.push({
        type: "TREND",
        message: "Strong finish - 3 passes in a row",
      });
    } else if (lastThreePasses === 0) {
      insights.push({
        type: "ALERT",
        message: "Concerning trend - 3 fails in recent days",
      });
    }
  }

  return insights;
}

// Helper: Fallback emoji mapping
function getEmojiForDomain(domainType) {
  const emojiMap = {
    SLEEP: "💤",
    BODY: "🏃",
    LEARNING: "📚",
    FUEL: "🥗",
    REFLECTION: "📝",
  };
  return emojiMap[domainType] || "⭐";
}

const getStreakStats = async (req, res) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_USER_ID",
          message: "userId is required",
        },
      });
    }

    console.log(`[Rule Engine] Fetching streak stats for user ${userId}`);

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_STREAK_STATISTICS @USERID = :userId`,
      {
        replacements: {
          userId,
        },
        type: QueryTypes.RAW,
      },
    );
    console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE RESULT SETS
    // [0] - Current streak summary
    // [1] - Achieved milestones
    // [2] - Next milestone
    // [3] - Recent streaks
    //=================================================
    //=================================================
    // PARSE FLAT RESULT SET
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No streak data found for user ${userId}`,
        },
      });
    }

    // 1️⃣ Summary row (has CurrentStreak)
    const summaryData = rows.find((r) => r.CurrentStreak !== undefined);

    // 2️⃣ Next milestone row (has Milestone + DaysAway)
    const nextMilestone = rows.find(
      (r) => r.Milestone !== undefined && r.DaysAway !== undefined,
    );

    // 3️⃣ Recent streak rows (have StartDate)
    const recentStreaks = rows.filter((r) => r.StartDate !== undefined);

    // 4️⃣ Achieved milestones (if your SP later returns them with AchievedDate)
    const achievedMilestones = rows.filter((r) => r.AchievedDate !== undefined);
    //=================================================
    // CHECK FOR ERRORS
    //=================================================
    if (summaryData && summaryData.ErrorCode) {
      return res.status(404).json({
        success: false,
        error: {
          code: summaryData.ErrorType || "USER_NOT_FOUND",
          message: summaryData.ErrorMessage,
          details: {
            userId: summaryData.UserId,
          },
        },
      });
    }

    if (!summaryData) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No streak data found for user ${userId}`,
        },
      });
    }

    //=================================================
    // BUILD RESPONSE
    //=================================================
    const responseData = {
      userId: summaryData.UserId,
      currentStreak: summaryData.CurrentStreak,
      longestStreak: summaryData.LongestStreak,
      longestStreakPeriod: {
        startDate: summaryData.LongestStreakStartDate,
        endDate: summaryData.LongestStreakEndDate,
        days: summaryData.LongestStreak,
      },
      consecutiveFailures: summaryData.ConsecutiveFailures,
      lastPassDate: summaryData.LastPassDate,
      lastFailDate: summaryData.LastFailDate,
      milestones: {
        next: nextMilestone
          ? {
              milestone: nextMilestone.Milestone,
              daysAway: nextMilestone.DaysAway,
              label: nextMilestone.Label,
            }
          : null,
        achieved: achievedMilestones.map((m) => ({
          milestone: m.Milestone,
          achievedDate: m.AchievedDate,
          label: m.Label,
        })),
      },
      recentStreaks: recentStreaks.map((streak) => ({
        startDate: streak.StartDate,
        endDate: streak.EndDate,
        days: streak.Days,
        status: streak.Status,
      })),
      totalStats: {
        totalDays: summaryData.TotalDays,
        totalPasses: summaryData.TotalPassDays,
        totalFails: summaryData.TotalFailDays,
        successRate: parseFloat(summaryData.SuccessRate.toFixed(2)),
      },
    };

    console.log(
      `[Rule Engine] ✓ Streak stats retrieved: Current ${summaryData.CurrentStreak}, Longest ${summaryData.LongestStreak}`,
    );

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[Rule Engine] Error fetching streak stats:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch streak statistics",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

const getOverallStats = async (req, res) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_USER_ID",
          message: "userId is required",
        },
      });
    }

    // console.log(`[Rule Engine] Fetching overall stats for user ${userId}`);

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_OVERALL_STATISTICS @USERID = :userId`,
      {
        replacements: {
          userId,
        },
        type: QueryTypes.RAW,
      },
    );
    console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE RESULT SETS
    // [0] - Period info
    // [1] - Overall performance
    // [2] - Streak summary
    // [3] - Average streak length
    // [4] - Mode distribution
    // [5] - Domain performance
    // [6] - Last 7 days trend
    // [7] - Last 30 days trend
    // [8] - Achievements
    //=================================================
    //=================================================
    // PARSE FLAT RESULT SET
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No data found for user ${userId}`,
        },
      });
    }

    // 1️⃣ Period info (has StartDate + EndDate)
    const periodData = rows.find(
      (r) =>
        r.StartDate !== undefined &&
        r.EndDate !== undefined &&
        r.UserId !== undefined,
    );

    // 2️⃣ Overall performance (has PassedDays + AverageCompletionRate)
    const performanceData = rows.find(
      (r) =>
        r.PassedDays !== undefined && r.AverageCompletionRate !== undefined,
    );

    // 3️⃣ Streak summary (has CurrentStreak)
    const streakSummary = rows.find((r) => r.CurrentStreak !== undefined);

    // 4️⃣ Streak average (has AverageStreakLength)
    const streakAverage = rows.find((r) => r.AverageStreakLength !== undefined);

    // 5️⃣ Mode distribution (has Mode)
    const modeDistribution = rows.filter((r) => r.Mode !== undefined);

    // 6️⃣ Domain performance (has DOMAINTYPE)
    const domainPerformance = rows.filter((r) => r.DOMAINTYPE !== undefined);

    // 7️⃣ Trend rows (have Days + Passes but no Mode or DOMAINTYPE)
    const trendRows = rows.filter(
      (r) =>
        r.Days !== undefined &&
        r.Passes !== undefined &&
        r.Mode === undefined &&
        r.DOMAINTYPE === undefined,
    );

    // Based on your console order:
    const last7Days = trendRows[0] || null;
    const last30Days = trendRows[1] || null;

    // 8️⃣ Achievements (not currently returned)
    const achievements = [];
    //=================================================
    // CHECK FOR ERRORS
    //=================================================
    if (periodData && periodData.ErrorCode) {
      return res.status(404).json({
        success: false,
        error: {
          code: periodData.ErrorType || "USER_NOT_FOUND",
          message: periodData.ErrorMessage,
          details: {
            userId: periodData.UserId,
          },
        },
      });
    }

    if (!periodData || !performanceData) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No data found for user ${userId}`,
        },
      });
    }

    //=================================================
    // BUILD MODE DISTRIBUTION
    //=================================================
    const modes = {
      standard: { days: 0, passes: 0, fails: 0, successRate: 0 },
      minimum: { days: 0, passes: 0, fails: 0, successRate: 0 },
    };

    modeDistribution.forEach((mode) => {
      const modeKey = mode.Mode.toLowerCase();
      modes[modeKey] = {
        days: mode.Days,
        passes: mode.Passes,
        fails: mode.Fails,
        successRate: parseFloat(mode.SuccessRate.toFixed(2)),
      };
    });

    //=================================================
    // BUILD DOMAIN PERFORMANCE
    //=================================================
    const domains = domainPerformance.map((domain) => ({
      domainType: domain.DOMAINTYPE,
      emoji: domain.DOMAINEMOJI || getEmojiForDomain(domain.DOMAINTYPE),
      totalAttempts: domain.TotalAttempts,
      completed: domain.Completed,
      completionRate: parseFloat(domain.CompletionRate.toFixed(2)),
      rank: domain.Rank,
    }));

    //=================================================
    // CALCULATE TRENDS
    //=================================================
    const overallSuccessRate = parseFloat(
      performanceData.SuccessRate.toFixed(2),
    );
    const last7DaysRate = last7Days
      ? parseFloat(last7Days.SuccessRate.toFixed(2))
      : 0;
    const last30DaysRate = last30Days
      ? parseFloat(last30Days.SuccessRate.toFixed(2))
      : 0;

    const trends = {
      last7Days: {
        successRate: last7DaysRate,
        trend: calculateTrend(last7DaysRate, overallSuccessRate),
        change: parseFloat((last7DaysRate - overallSuccessRate).toFixed(2)),
      },
      last30Days: {
        successRate: last30DaysRate,
        trend: calculateTrend(last30DaysRate, overallSuccessRate),
        change: parseFloat((last30DaysRate - overallSuccessRate).toFixed(2)),
      },
    };

    //=================================================
    // BUILD ACHIEVEMENTS
    //=================================================
    const achievementsList = achievements.map((ach) => ({
      type: ach.Type,
      title: ach.Title,
      achievedDate: ach.AchievedDate,
      description: ach.Description,
    }));

    // Add success rate achievements
    if (overallSuccessRate >= 80) {
      achievementsList.push({
        type: "SUCCESS_RATE",
        title: "80% Success Rate",
        achievedDate: periodData.EndDate,
        description: "Maintained 80%+ success rate",
      });
    }

    //=================================================
    // BUILD RESPONSE
    //=================================================
    const responseData = {
      userId: periodData.UserId,
      period: {
        startDate: periodData.StartDate,
        endDate: periodData.EndDate,
        totalDays: periodData.TotalDays,
      },
      overallPerformance: {
        totalDays: performanceData.TotalDays,
        passedDays: performanceData.PassedDays,
        failedDays: performanceData.FailedDays,
        successRate: overallSuccessRate,
        averageCompletionRate: parseFloat(
          performanceData.AverageCompletionRate.toFixed(2),
        ),
      },
      streaks: {
        currentStreak: streakSummary.CurrentStreak,
        longestStreak: streakSummary.LongestStreak,
        averageStreakLength: streakAverage
          ? parseFloat(streakAverage.AverageStreakLength.toFixed(2))
          : 0,
        totalStreaks: streakAverage ? streakAverage.TotalStreaks : 0,
      },
      modeDistribution: modes,
      domainPerformance: domains,
      trends,
      achievements: achievementsList.slice(0, 10), // Limit to 10 most recent
    };

    console.log(
      `[Rule Engine] ✓ Overall stats retrieved: ${performanceData.PassedDays}/${performanceData.TotalDays} passed (${overallSuccessRate}%)`,
    );

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[Rule Engine] Error fetching overall stats:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch overall statistics",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

// Helper: Calculate trend direction
function calculateTrend(recentRate, overallRate) {
  const diff = recentRate - overallRate;
  if (diff > 2) return "UP";
  if (diff < -2) return "DOWN";
  return "STABLE";
}

const getModeHistory = async (req, res) => {
  try {
    const userId = req.userId;

    console.log(`[Rule Engine] Fetching mode history for user ${userId}`);

    //=================================================
    // EXECUTE STORED PROCEDURE
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_GET_MODE_CHANGE_HISTORY @USERID = :userId`,
      {
        replacements: {
          userId,
        },
        type: QueryTypes.RAW,
      },
    );

    console.log(JSON.stringify(result, null, 2));

    //=================================================
    // PARSE FLAT RESULT SET
    //=================================================
    const rows = result[0] || [];

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No data found for user ${userId}`,
        },
      });
    }

    // 1️⃣ Current status
    const currentStatus = rows.find((r) => r.CurrentMode !== undefined);

    // 2️⃣ Mode change history
    const modeHistory = rows.filter((r) => r.MODECHANGEID !== undefined);

    // 3️⃣ Mode statistics
    const modeStats = rows.filter(
      (r) => r.Mode !== undefined && r.TotalDays !== undefined,
    );

    // 4️⃣ Mode periods
    const modePeriods = rows.filter(
      (r) => r.Mode !== undefined && r.StartDate !== undefined,
    );

    //=================================================
    // CHECK FOR ERRORS
    //=================================================
    if (currentStatus && currentStatus.ErrorCode) {
      return res.status(404).json({
        success: false,
        error: {
          code: currentStatus.ErrorType || "USER_NOT_FOUND",
          message: currentStatus.ErrorMessage,
          details: {
            userId: currentStatus.UserId,
          },
        },
      });
    }

    if (!currentStatus) {
      return res.status(404).json({
        success: false,
        error: {
          code: "NO_DATA",
          message: `No data found for user ${userId}`,
        },
      });
    }

    //=================================================
    // BUILD MODE HISTORY
    //=================================================
    const history = modeHistory.map((change) => ({
      modeChangeId: change.MODECHANGEID,
      previousMode: change.PREVIOUSMODE,
      newMode: change.NEWMODE,
      changeReason: change.CHANGEREASON,
      changedAt: change.CHANGEDAT,
      triggeringDayId: change.TRIGGERINGDAYID,
      consecutiveFailures: change.CONSECUTIVEFAILURESATCHANGE,
      effectiveDate: change.EFFECTIVEDATE,
      schedulerNotified: Boolean(change.SCHEDULERNOTIFIED),
    }));

    //=================================================
    // BUILD MODE STATISTICS
    //=================================================
    const statistics = {};
    modeStats.forEach((stat) => {
      const modeKey = stat.Mode.toLowerCase();
      statistics[modeKey] = {
        totalDays: stat.TotalDays,
        passedDays: stat.PassedDays,
        failedDays: stat.FailedDays,
        successRate: parseFloat(stat.SuccessRate.toFixed(2)),
        firstDay: stat.FirstDay,
        lastDay: stat.LastDay,
      };
    });

    //=================================================
    // BUILD MODE PERIODS
    //=================================================
    const periods = modePeriods.map((period) => ({
      mode: period.Mode,
      startDate: period.StartDate,
      endDate: period.EndDate,
      daysInMode: period.DaysInMode,
      isActive:
        !period.EndDate ||
        new Date(period.EndDate) >= new Date().setHours(0, 0, 0, 0),
    }));

    //=================================================
    // GENERATE INSIGHTS
    //=================================================
    const insights = generateModeInsights(
      currentStatus,
      modeHistory,
      statistics,
    );

    //=================================================
    // BUILD RESPONSE
    //=================================================
    const responseData = {
      userId: currentStatus.UserId,
      currentStatus: {
        currentMode: currentStatus.CurrentMode,
        currentStreak: currentStatus.CurrentStreak,
        consecutiveFailures: currentStatus.ConsecutiveFailures,
        lastModeChangeDate: currentStatus.LastModeChangeDate,
        readyForRecovery: Boolean(currentStatus.ReadyForRecovery),
        inMinimumModeThreshold: Boolean(currentStatus.InMinimumModeThreshold),
      },
      modeHistory: history,
      statistics,
      periods,
      insights,
    };

    console.log(
      `[Rule Engine] ✓ Mode history retrieved: Current mode ${currentStatus.CurrentMode}, ${history.length} changes`,
    );

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[Rule Engine] Error fetching mode history:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch mode change history",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

// Helper: Generate insights from mode data
function generateModeInsights(currentStatus, modeHistory, statistics) {
  const insights = [];

  // Current mode insight
  if (currentStatus.CurrentMode === "MINIMUM") {
    if (currentStatus.ReadyForRecovery) {
      insights.push({
        type: "RECOVERY_AVAILABLE",
        severity: "SUCCESS",
        message: `You're ready to return to Standard Mode! Complete today successfully.`,
      });
    } else {
      const passesNeeded = 3 - currentStatus.CurrentStreak;
      insights.push({
        type: "MINIMUM_MODE_ACTIVE",
        severity: "INFO",
        message: `Currently in Minimum Mode. ${passesNeeded} more ${
          passesNeeded === 1 ? "pass" : "passes"
        } needed to return to Standard.`,
      });
    }
  } else {
    // Standard mode
    if (currentStatus.InMinimumModeThreshold) {
      insights.push({
        type: "MINIMUM_MODE_WARNING",
        severity: "CRITICAL",
        message: `3 consecutive failures detected. Next failure enters Minimum Mode.`,
      });
    } else if (currentStatus.ConsecutiveFailures > 0) {
      const failuresLeft = 3 - currentStatus.ConsecutiveFailures;
      insights.push({
        type: "FAILURE_WARNING",
        severity: "WARNING",
        message: `${currentStatus.ConsecutiveFailures} consecutive ${
          currentStatus.ConsecutiveFailures === 1 ? "failure" : "failures"
        }. ${failuresLeft} more will trigger Minimum Mode.`,
      });
    }
  }

  // Mode change history insight
  if (modeHistory.length > 0) {
    const minimumModeChanges = modeHistory.filter(
      (h) => h.NEWMODE === "MINIMUM",
    );
    const recoveries = modeHistory.filter((h) => h.NEWMODE === "STANDARD");

    if (minimumModeChanges.length > 0) {
      insights.push({
        type: "HISTORY",
        severity: "INFO",
        message: `Entered Minimum Mode ${minimumModeChanges.length} ${
          minimumModeChanges.length === 1 ? "time" : "times"
        }. Recovered ${recoveries.length} ${
          recoveries.length === 1 ? "time" : "times"
        }.`,
      });
    }
  }

  // Performance comparison
  if (statistics.standard && statistics.minimum) {
    const standardRate = statistics.standard.successRate;
    const minimumRate = statistics.minimum.successRate;

    if (minimumRate > standardRate) {
      insights.push({
        type: "PERFORMANCE",
        severity: "INFO",
        message: `Success rate in Minimum Mode (${minimumRate.toFixed(
          0,
        )}%) was higher than Standard (${standardRate.toFixed(
          0,
        )}%). Minimum mode helps recovery.`,
      });
    }
  }

  return insights;
}

module.exports = {
  getWeekStats,
  getStreakStats,
  getOverallStats,
  getModeHistory,
};
