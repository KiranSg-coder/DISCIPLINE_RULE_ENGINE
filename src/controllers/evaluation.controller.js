const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const axios = require("axios");
const eventPublisher = require("../utils/eventPublisher");
const { EVENT_TYPES, EVENT_CATEGORIES } = require("../config/eventTypes");

const DIRECT_NOTIFICATION_ENABLED =
  process.env.DIRECT_NOTIFICATION_ENABLED === "true";

const evaluateDay = async (req, res) => {
  const evaluationStart = new Date();

  try {
    const { dayId, userId, triggeredBy, triggeredAt } = req.body;

    //=================================================
    // VALIDATION: Required Fields
    //=================================================
    if (!dayId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_DAY_ID",
          message: "dayId is required",
        },
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_USER_ID",
          message: "userId is required",
        },
      });
    }

    console.log(
      `[Rule Engine] Starting evaluation for day ${dayId}, user ${userId}`,
    );

    //=================================================
    // STEP 1: Fetch day summary from Daily Execution Service
    //=================================================
    const apiCallStart = Date.now();

    let daySummary;
    try {
      const summaryResponse = await axios.get(
        `${process.env.DAILY_EXECUTION_URL}/internal/day/${dayId}/summary`,
        {
          headers: {
            "X-Service-Key": process.env.INTERNAL_SERVICE_KEY,
          },
        },
      );

      if (!summaryResponse.data.success) {
        throw new Error(
          `Failed to fetch day summary: ${summaryResponse.data.error.message}`,
        );
      }

      daySummary = summaryResponse.data.data;
      console.log(
        `[Rule Engine] Day summary fetched: ${daySummary.completedRulesCount}/${daySummary.totalRules} completed`,
      );
    } catch (apiError) {
      console.error(`[Rule Engine] API call failed:`, apiError.message);
      return res.status(503).json({
        success: false,
        error: {
          code: "DAILY_EXECUTION_SERVICE_ERROR",
          message: "Failed to fetch day data from Daily Execution Service",
          details: apiError.message,
        },
      });
    }

    const apiCallDuration = Date.now() - apiCallStart;

    //=================================================
    // STEP 2: Execute evaluation stored procedure
    //=================================================
    const result = await sequelize.query(
      `EXEC USP_EVALUATE_DAY
          @DAYID = :dayId,
          @USERID = :userId,
          @TRIGGEREDBY = :triggeredBy,
          @EVALUATIONSTART = :evaluationStart`,
      {
        replacements: {
          dayId: parseInt(dayId),
          userId: parseInt(userId),
          triggeredBy: triggeredBy || "SCHEDULER",
          evaluationStart: evaluationStart.toISOString(),
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
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from evaluation procedure",
        },
      });
    }

    // Parse different row types
    const statusResult = rows.find((r) => r.ErrorCode !== undefined);
    const evaluationData = rows.find((r) => r.EvaluationId !== undefined);
    const streakData = rows.find((r) => r.CurrentStreak !== undefined);
    const analyticsData = rows.find((r) => r.TotalDays !== undefined);
    const actionsData = rows.find((r) => r.MinimumModeTriggered !== undefined);
    const performanceData = rows.find(
      (r) => r.EvaluationDurationMs !== undefined,
    );
    const weekData = rows.find((r) => r.WeekPasses !== undefined);

    if (!statusResult) {
      return res.status(500).json({
        success: false,
        error: {
          code: "NO_RESULT",
          message: "No result returned from evaluation procedure",
        },
      });
    }

    //=================================================
    // HANDLE ERRORS FROM STORED PROCEDURE
    //=================================================
    if (statusResult.ErrorCode !== 0) {
      const errorMap = {
        1: { status: 409, code: "ALREADY_EVALUATED" },
        2: { status: 404, code: "DAY_NOT_FOUND" },
        3: { status: 400, code: "DAY_NOT_CLOSED" },
        99: { status: 500, code: "INTERNAL_ERROR" },
      };

      const errorInfo = errorMap[statusResult.ErrorCode] || {
        status: 500,
        code: "UNKNOWN_ERROR",
      };

      const errorResponse = {
        success: false,
        error: {
          code: statusResult.ErrorType || errorInfo.code,
          message: statusResult.ErrorMessage,
          details: {},
        },
      };

      if (statusResult.ErrorCode === 1) {
        errorResponse.error.details = {
          dayId: parseInt(dayId),
          existingEvaluationId: statusResult.ExistingEvaluationId,
          evaluatedAt: statusResult.EvaluatedAt,
          result: statusResult.Result,
        };
      } else if (statusResult.ErrorCode === 3) {
        errorResponse.error.details = {
          dayId: parseInt(dayId),
          currentStatus: statusResult.CurrentStatus,
        };
      }

      return res.status(errorInfo.status).json(errorResponse);
    }

    //=================================================
    // STEP 3: Update Daily Execution Service with result
    //=================================================
    try {
      await axios.post(
        `${process.env.DAILY_EXECUTION_URL}/internal/day/${dayId}/result`,
        {
          dayId: parseInt(dayId),
          result: evaluationData.Result,
          evaluatedAt: evaluationData.EvaluatedAt,
          totalRequired: evaluationData.TotalRequired,
          totalCompleted: evaluationData.Completed,
          missedRules: evaluationData.MissedRuleIds
            ? evaluationData.MissedRuleIds.split(",").map((id) => parseInt(id))
            : [],
        },
        {
          headers: {
            "X-Service-Key": process.env.INTERNAL_SERVICE_KEY,
          },
        },
      );

      console.log(
        `[Rule Engine] Result updated in Daily Execution: ${evaluationData.Result}`,
      );
    } catch (updateError) {
      console.error(
        `[Rule Engine] Failed to update result:`,
        updateError.message,
      );
    }

    //=================================================
    // STEP 4: Trigger notifications
    //=================================================
    let notificationSent = false;
    if (DIRECT_NOTIFICATION_ENABLED) {
      try {
        await sendVerdictNotification(
          userId,
          dayId,
          evaluationData,
          streakData
        );
        notificationSent = true;
        console.log(`[Rule Engine] Notification sent to user ${userId} (direct)`);
      } catch (notifError) {
        console.error(
          `[Rule Engine] Failed to send notification (direct):`,
          notifError.message,
        );
      }
    }

    //=================================================
    // STEP 5: Handle mode changes
    //=================================================
    let schedulerNotified = false;

    // Handle MINIMUM mode trigger
    if (actionsData.MinimumModeTriggered) {
      try {
        await notifySchedulerForModeChange(
          userId,
          "MINIMUM",
          actionsData.MinimumModeReason,
          daySummary.date,
          actionsData.ModeChangeId,
        );
        schedulerNotified = true;
        console.log(
          `[Rule Engine] ⚠️ Scheduler notified: MINIMUM MODE for user ${userId}`,
        );
      } catch (schedError) {
        console.error(
          `[Rule Engine] Failed to notify scheduler:`,
          schedError.message,
        );
      }
    }

    // Handle RECOVERY mode trigger
    if (actionsData.RecoveryModeTriggered) {
      try {
        await notifySchedulerForModeChange(
          userId,
          "STANDARD",
          "Recovery: 3 consecutive passes in minimum mode",
          daySummary.date,
          actionsData.ModeChangeId,
        );
        schedulerNotified = true;
        console.log(
          `[Rule Engine] ✅ Scheduler notified: RECOVERY to STANDARD for user ${userId}`,
        );
      } catch (schedError) {
        console.error(
          `[Rule Engine] Failed to notify scheduler:`,
          schedError.message,
        );
      }
    }

    // 1) DAY_EVALUATED
    await eventPublisher.publish(
      EVENT_TYPES.DAY_EVALUATED,
      EVENT_CATEGORIES.DAY_LIFECYCLE,
      {
        evaluationId: evaluationData.EvaluationId,
        dayId: evaluationData.DayId,
        userId: evaluationData.UserId,
        dayDate: evaluationData.DayDate,
        dayNumber: evaluationData.DayNumber,
        result: evaluationData.Result,
        completedRules: evaluationData.Completed,
        totalRules: evaluationData.TotalRequired,
        completionPercentage: evaluationData.CompletionPercentage,
        evaluatedAt: evaluationData.EvaluatedAt,
      },
      {
        entityType: "EVALUATION",
        entityId: evaluationData.EvaluationId,
      },
    );

    // 2) VERDICT_PASS / VERDICT_FAIL
    const verdictEventType =
      evaluationData.Result === "PASS"
        ? EVENT_TYPES.VERDICT_PASS
        : EVENT_TYPES.VERDICT_FAIL;

    await eventPublisher.publish(
      verdictEventType,
      EVENT_CATEGORIES.VERDICT,
      {
        dayId: evaluationData.DayId,
        userId: evaluationData.UserId,
        dayNumber: evaluationData.DayNumber,
        result: evaluationData.Result,
        completedRules: evaluationData.Completed,
        totalRules: evaluationData.TotalRequired,
        currentStreak: streakData.CurrentStreak,
        consecutiveFailures: streakData.ConsecutiveFailures,
      },
      {
        entityType: "EVALUATION",
        entityId: evaluationData.EvaluationId,
      },
    );

    // 3) STREAK_UPDATED
    if (streakData.PreviousStreak !== streakData.CurrentStreak) {
      await eventPublisher.publish(
        EVENT_TYPES.STREAK_UPDATED,
        EVENT_CATEGORIES.VERDICT,
        {
          userId: evaluationData.UserId,
          currentStreak: streakData.CurrentStreak,
          previousStreak: streakData.PreviousStreak,
          longestStreak: streakData.LongestStreak,
          streakType:
            streakData.CurrentStreak > streakData.PreviousStreak
              ? "INCREASED"
              : "BROKEN",
        },
        {
          entityType: "STREAK",
          entityId: evaluationData.UserId,
        },
      );
    }

    // 4) MODE change events
    if (actionsData.MinimumModeTriggered || actionsData.RecoveryModeTriggered) {
      const newMode = actionsData.MinimumModeTriggered ? "MINIMUM" : "STANDARD";
      const prevMode = newMode === "MINIMUM" ? "STANDARD" : "MINIMUM";
      const modeEventType =
        newMode === "MINIMUM"
          ? EVENT_TYPES.MODE_CHANGED_TO_MINIMUM
          : EVENT_TYPES.MODE_CHANGED_TO_STANDARD;

      await eventPublisher.publish(
        modeEventType,
        EVENT_CATEGORIES.MODE_CHANGE,
        {
          userId: evaluationData.UserId,
          previousMode: prevMode,
          newMode,
          reason:
            newMode === "MINIMUM" ? actionsData.MinimumModeReason : "RECOVERY",
          effectiveDate: evaluationData.DayDate,
          consecutiveFailures: streakData.ConsecutiveFailures,
          triggeringDayId: evaluationData.DayId,
        },
        {
          entityType: "MODE_CHANGE",
          entityId: actionsData.ModeChangeId,
        },
      );
    }

    // 5) ACHIEVEMENT_UNLOCKED – award via USP_AWARD_ACHIEVEMENTS
    let awardedAchievements = [];
    try {
      const awardResult = await sequelize.query(
        `EXEC USP_AWARD_ACHIEVEMENTS
            @USERID = :userId,
            @TRIGGER = :trigger`,
        {
          replacements: {
            userId: parseInt(userId),
            trigger: "EVALUATION",
          },
          type: QueryTypes.RAW,
        },
      );

      awardedAchievements = (awardResult[0] || []).filter(
        (r) => r.ACHIEVEMENTID != null || r.AchievementId != null || r.CODE != null || r.Code != null,
      );

      for (const ach of awardedAchievements) {
        const code = ach.CODE || ach.Code;
        const name = ach.NAME || ach.Name;
        const tier = ach.TIER || ach.Tier;
        const category = ach.CATEGORY || ach.Category;
        const achievementId = ach.ACHIEVEMENTID || ach.AchievementId;

        await eventPublisher.publish(
          EVENT_TYPES.ACHIEVEMENT_UNLOCKED,
          EVENT_CATEGORIES.ACHIEVEMENT,
          {
            userId: evaluationData.UserId,
            achievementId,
            achievementCode: code,
            achievementType: category,
            achievementName: name,
            tier,
            streakDays: streakData.CurrentStreak,
            unlockedAt: evaluationData.EvaluatedAt,
          },
          {
            entityType: "ACHIEVEMENT",
            entityId: `${evaluationData.UserId}-${code || achievementId}`,
          },
        );
      }
    } catch (awardError) {
      console.error(
        `[Rule Engine] Failed to award achievements:`,
        awardError.message,
      );
    }

    //=================================================
    // BUILD RESPONSE
    //=================================================
    const streakMilestone = checkMilestone(streakData.CurrentStreak);
    const responseData = {
      evaluationId: evaluationData.EvaluationId,
      dayId: evaluationData.DayId,
      userId: evaluationData.UserId,
      dayDate: evaluationData.DayDate,
      dayNumber: evaluationData.DayNumber,
      result: evaluationData.Result,
      evaluatedAt: evaluationData.EvaluatedAt,
      evaluation: {
        mode: evaluationData.Mode,
        totalRequired: evaluationData.TotalRequired,
        completed: evaluationData.Completed,
        completionPercentage: parseFloat(evaluationData.CompletionPercentage),
        missedRules: evaluationData.MissedRuleIds
          ? evaluationData.MissedRuleIds.split(",").map((id) => parseInt(id))
          : [],
        missedDomains: evaluationData.MissedDomains
          ? evaluationData.MissedDomains.split(",")
          : [],
      },
      streaks: {
        currentStreak: streakData.CurrentStreak,
        longestStreak: streakData.LongestStreak,
        isNewRecord: Boolean(streakData.IsNewRecord),
        consecutiveFailures: streakData.ConsecutiveFailures,
        milestoneReached: streakMilestone,
      },
      achievements: {
        newlyAwarded: awardedAchievements.map((ach) => ({
          achievementId: ach.ACHIEVEMENTID || ach.AchievementId,
          code: ach.CODE || ach.Code,
          name: ach.NAME || ach.Name,
          tier: ach.TIER || ach.Tier,
          category: ach.CATEGORY || ach.Category,
        })),
      },
      analytics: {
        totalDays: analyticsData.TotalDays,
        totalPasses: analyticsData.TotalPasses,
        totalFails: analyticsData.TotalFails,
        successRate: parseFloat(analyticsData.SuccessRate),
        weekPerformance: {
          passes: weekData.WeekPasses,
          fails: weekData.WeekFails,
          total: weekData.WeekTotal,
          rate: parseFloat(weekData.WeekSuccessRate),
        },
      },
      actions: {
        notificationSent,
        minimumModeTriggered: Boolean(actionsData.MinimumModeTriggered),
        recoveryModeTriggered: Boolean(actionsData.RecoveryModeTriggered),
        modeChangeId: actionsData.ModeChangeId || null,
        minimumModeReason: actionsData.MinimumModeReason,
        analyticsUpdated: true,
        schedulerNotified,
      },
      performance: {
        evaluationDurationMs: performanceData.EvaluationDurationMs,
        apiCallsMs: performanceData.ApiCallsMs,
        calculationMs: performanceData.CalculationMs,
      },
    };

    // Add streak broken info for failures
    if (evaluationData.Result === "FAIL" && streakData.PreviousStreak > 0) {
      responseData.streaks.streakBroken = {
        previousStreak: streakData.PreviousStreak,
        brokenAt: evaluationData.DayDate,
      };
    }

    // Add failure reason if failed
    if (evaluationData.Result === "FAIL") {
      responseData.evaluation.failureReason = evaluationData.FailureReason;
    }

    // Add alerts for consecutive failures or recovery
    responseData.actions.alerts = [];

    if (streakData.ConsecutiveFailures > 0) {
      if (streakData.ConsecutiveFailures === 1) {
        responseData.actions.alerts.push({
          type: "CONSECUTIVE_FAILURE",
          severity: "WARNING",
          message: "1 consecutive failure. 2 more will trigger Minimum Mode.",
        });
      } else if (streakData.ConsecutiveFailures === 2) {
        responseData.actions.alerts.push({
          type: "CONSECUTIVE_FAILURE",
          severity: "WARNING",
          message: "2 consecutive failures. 1 more will trigger Minimum Mode.",
        });
      } else if (streakData.ConsecutiveFailures >= 3) {
        responseData.actions.alerts.push({
          type: "MINIMUM_MODE_TRIGGERED",
          severity: "CRITICAL",
          message: `${streakData.ConsecutiveFailures} consecutive failures. Entering Minimum Mode for next day.`,
          action: "Next day will use minimum rules only",
        });
      }
    }

    if (actionsData.RecoveryModeTriggered) {
      responseData.actions.alerts.push({
        type: "RECOVERY_MODE_TRIGGERED",
        severity: "SUCCESS",
        message: "3 consecutive passes. Returning to Standard Mode.",
        action: "Next day will use all rules",
      });
    }

    console.log(
      `[Rule Engine] ✓ Evaluation complete for day ${dayId}: ${evaluationData.Result}`,
    );

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[Rule Engine] Error evaluating day:", error);

    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to evaluate day",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
};

// Helper: Check if streak reached a milestone
function checkMilestone(streak) {
  const milestones = [3, 5, 7, 10, 14, 21, 30, 50, 100];
  if (milestones.includes(streak)) {
    return {
      milestone: streak,
      label: `${streak}-day streak`,
    };
  }
  return null;
}

// Helper: Send verdict notification (uses Notification service template API: templateCode + data)
async function sendVerdictNotification(
  userId,
  dayId,
  evaluationData,
  streakData,
) {
  const baseUrl = (process.env.NOTIFICATION_SERVICE_URL || "").replace(
    /\/$/,
    "",
  );
  const url = baseUrl
    ? `${baseUrl}/internal/send`
    : "http://localhost:6010/internal/send";

  await axios.post(
    url,
    {
      userId,
      templateCode: "VERDICT_READY",
      data: {
        dayId,
        result: evaluationData.Result,
        dayNumber: evaluationData.DayNumber,
        streak:
          evaluationData.Result === "PASS" && streakData.CurrentStreak >= 3
            ? streakData.CurrentStreak
            : null,
      },
      priority: "HIGH",
    },
    {
      headers: {
        "X-Service-Key": process.env.INTERNAL_SERVICE_KEY,
      },
    },
  );
}

// Helper: Notify scheduler for mode change
async function notifySchedulerForModeChange(
  userId,
  newMode,
  reason,
  currentDate,
  modeChangeId,
) {
  const nextDate = new Date(currentDate);
  nextDate.setDate(nextDate.getDate() + 1);

  await axios.post(
    `${process.env.SCHEDULER_SERVICE_URL}/webhook/mode-change`,
    {
      userId,
      newMode,
      reason,
      effectiveDate: nextDate.toISOString().split("T")[0],
      modeChangeId,
      // Deliberately null. The authoritative recovery rules live in
      // RULE_MANAGEMENT.MINIMUM_RULE and are resolved at day creation by
      // transformRulesForDaily(). This used to send a hard-coded [1, 4]
      // ("Sleep + Reflection"), which ignored the user's actual selection and
      // wrote misleading data into PENDING_MODE_CHANGES.MINIMUMRULEIDS.
      minimumRuleIds: null,
    },
    {
      headers: {
        "X-Service-Key": process.env.INTERNAL_SERVICE_KEY,
      },
      timeout: 8000,
    },
  );
}

/**
 * POST /internal/achievements/award
 * Body: { userId, trigger: 'EVALUATION' | 'CHALLENGE_COMPLETE', context?: { durationDays, challengeLevel } }
 */
async function awardAchievements(req, res) {
  try {
    const { userId, trigger, context } = req.body || {};

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: { code: "MISSING_USER_ID", message: "userId is required" },
      });
    }

    const awardTrigger = (trigger || "EVALUATION").toUpperCase();
    if (!["EVALUATION", "CHALLENGE_COMPLETE"].includes(awardTrigger)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_TRIGGER",
          message: "trigger must be EVALUATION or CHALLENGE_COMPLETE",
        },
      });
    }

    const contextJson =
      context != null ? JSON.stringify(context) : null;

    const result = await sequelize.query(
      `EXEC USP_AWARD_ACHIEVEMENTS
          @USERID = :userId,
          @TRIGGER = :trigger,
          @CONTEXTJSON = :contextJson`,
      {
        replacements: {
          userId: parseInt(userId, 10),
          trigger: awardTrigger,
          contextJson,
        },
        type: QueryTypes.RAW,
      },
    );

    const awarded = (result[0] || []).filter(
      (r) => r.ACHIEVEMENTID != null || r.AchievementId != null || r.CODE != null || r.Code != null,
    );

    const mapped = awarded.map((ach) => ({
      achievementId: ach.ACHIEVEMENTID || ach.AchievementId,
      code: ach.CODE || ach.Code,
      name: ach.NAME || ach.Name,
      tier: ach.TIER || ach.Tier,
      category: ach.CATEGORY || ach.Category,
    }));

    for (const ach of mapped) {
      try {
        await eventPublisher.publish(
          EVENT_TYPES.ACHIEVEMENT_UNLOCKED,
          EVENT_CATEGORIES.ACHIEVEMENT,
          {
            userId: parseInt(userId, 10),
            achievementId: ach.achievementId,
            achievementCode: ach.code,
            achievementType: ach.category,
            achievementName: ach.name,
            tier: ach.tier,
            unlockedAt: new Date().toISOString(),
            trigger: awardTrigger,
            context: context || null,
          },
          {
            entityType: "ACHIEVEMENT",
            entityId: `${userId}-${ach.code || ach.achievementId}`,
          },
        );
      } catch (publishError) {
        console.error(
          `[Rule Engine] Failed to publish ACHIEVEMENT_UNLOCKED for ${ach.code}:`,
          publishError.message,
        );
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        userId: parseInt(userId, 10),
        trigger: awardTrigger,
        newlyAwarded: mapped,
      },
    });
  } catch (error) {
    console.error("[Rule Engine] Error awarding achievements:", error);
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to award achievements",
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      },
    });
  }
}

module.exports = { evaluateDay, awardAchievements };
