# Discipline Rule Engine Service & Database — Review

**Reviewed:** DISCIPLINE_RULE_ENGINE microservice + DISCIPLINE_RULE_ENGINE MSSQL database and stored procedures  
**Aligned to:** P-OS BRD (day evaluation, verdict, streaks, 3-fail → Minimum Mode, 3-pass recovery, analytics)

---

## 1. Service Overview

| Item | Value |
|------|--------|
| **Stack** | Node.js, Express, Sequelize, MSSQL, Axios |
| **Default port** | 5002 (was 3002; changed to align with 5000, 5001) |
| **Gateway path** | `/discipline` → pathRewrite to `` (e.g. `POST /discipline/internal/evaluate` → engine `POST /internal/evaluate`) |

**Route summary**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /internal/evaluate | Evaluate a closed day (Scheduler calls after day close): streaks, audit, mode-change logic, then update Daily Execution result and notify |
| GET | /internal/stats/week | Week statistics (summary, daily breakdown, domain performance, pattern). Query: `userId`, `startDate` (week start YYYY-MM-DD) |
| GET | /internal/stats/streak | Streak statistics (current, longest, milestones, next milestone, recent streaks). Query: `userId` |
| GET | /internal/stats/overall | Overall statistics (period, performance, streak summary, mode distribution, domain performance, trends, achievements). Query: `userId` |
| GET | /internal/stats/mode-history | Mode change history (current status, history list, mode distribution, recent mode periods). Query: `userId` |

All endpoints are “internal” in the sense of backend-for-frontend or Scheduler; the gateway exposes them under `/discipline` so the app and Scheduler can call them.

---

## 2. Database Schema — Alignment with BRD

### 2.1 Tables

1. **DAYEVALUATIONAUDIT** — One row per evaluated day. DAYID (unique), USERID, DAYDATE, DAYNUMBER, EVALUATEDAT, RESULT (PASS/FAIL), TOTALREQUIREDRULES, COMPLETEDRULES, COMPLETIONPERCENTAGE, MISSINGRULEIDS, MISSEDDOMAINS, EVALUATIONMODE (STANDARD/MINIMUM), FAILUREREASON, RULESETVERSION, EVALUATIONDURATIONMS, PREVIOUSRESULT, CONSECUTIVEFAILURES, CURRENTSTREAK, CREATEDDATE.  
   **BRD:** Audit trail for each day evaluation; supports verdict and analytics.

2. **USERSTREAK** — One row per user. CURRENTSTREAK, LONGESTSTREAK, LONGESTSTREAKSTARTDATE, LONGESTSTREAKENDDATE, CONSECUTIVEFAILURES, LASTPASSDATE, LASTFAILDATE, TOTALPASSDAYS, TOTALFAILDAYS, TOTALDAYS, SUCCESSRATE, LASTUPDATED.  
   **BRD:** Streaks and success rate for verdict and recovery logic.

3. **MODECHANGEHISTORY** — Mode changes: USERID, PREVIOUSMODE, NEWMODE, CHANGEREASON (MANUAL | RECOVERY | FAILURE_THRESHOLD), CHANGEDAT, TRIGGERINGDAYID, CONSECUTIVEFAILURESATCHANGE, SCHEDULERNOTIFIED, EFFECTIVEDATE.  
   **BRD:** 3 consecutive failures → STANDARD→MINIMUM; 3 consecutive passes in MINIMUM → RECOVERY to STANDARD.

4. **DOMAINPERFORMANCE** — Weekly per-user per-domain aggregates (USERID, DOMAINTYPE, WEEKSTARTDATE, WEEKENDDATE, TOTALDAYS, COMPLETEDDAYS, COMPLETIONRATE). Unique (USERID, DOMAINTYPE, WEEKSTARTDATE).  
   **BRD:** Supports weekly domain analytics (USP_GET_WEEK_STATISTICS uses Daily Execution data; this table can be used for caching/aggregates if populated).

**Cross-database:** Stored procedures read from **DAILY_EXECUTION.dbo** (USERDAY, DAYCHECKLISTITEM) and **RULE_MANAGEMENT.dbo** (DOMAIN_MASTER). All three databases must be on the same SQL Server (or linked server) with appropriate permissions.

**Terminology (BR-002):** RESULT is stored as PASS/FAIL. For user-facing copy, map FAIL → "Incomplete" in API responses.

---

## 3. Stored Procedures — Summary

| SP | Purpose | Notes |
|----|---------|-------|
| **USP_EVALUATE_DAY** | Evaluate a closed day: read USERDAY + DAYCHECKLISTITEM from DAILY_EXECUTION.dbo; compute completion %, missing rules/domains; update USERSTREAK; if 3+ consecutive failures in STANDARD → insert MODECHANGEHISTORY (MINIMUM, FAILURE_THRESHOLD); if 3+ consecutive passes in MINIMUM → insert MODECHANGEHISTORY (STANDARD, RECOVERY); insert DAYEVALUATIONAUDIT; return 7 result sets (status, evaluation, streak, analytics, actions, performance, week). | Rejects if day already evaluated or not closed. |
| **USP_GET_MODE_CHANGE_HISTORY** | Current mode/streak, last mode change date, ReadyForRecovery/InMinimumModeThreshold; mode change history list; mode distribution stats; recent mode periods. | Uses USERSTREAK + DAYEVALUATIONAUDIT + MODECHANGEHISTORY. |
| **USP_GET_OVERALL_STATISTICS** | Period (start/end, total days); overall performance (pass/fail, success rate, avg completion); streak summary; average streak length; mode distribution; domain performance (from DAILY_EXECUTION + RULE_MANAGEMENT); last 7/30 days trend; streak milestones (3,5,7,10,14,21,30,50,100). | 9 result sets. |
| **USP_GET_STREAK_STATISTICS** | Current streak summary; achieved milestones; next milestone (days away); recent streaks (last 5). | Uses USERSTREAK + DAYEVALUATIONAUDIT. |
| **USP_GET_WEEK_STATISTICS** | Week summary (total/passed/failed, success rate, current streak); daily breakdown; domain performance (from DAILY_EXECUTION.dbo + RULE_MANAGEMENT.dbo); week pattern string (✓/✗). | Query params: USERID, WEEKSTARTDATE. |

**Important:** USP_EVALUATE_DAY reads day data **directly from DAILY_EXECUTION.dbo** (no HTTP). The Node controller additionally calls the Daily Execution **API** for day summary (for validation and for `daySummary.date` when notifying Scheduler) and then **POSTs the evaluation result** back to Daily Execution (`/internal/day/:dayId/result`) so USERDAY.RESULT and EVALUATEDAT stay in sync. The SP does not write to Daily Execution.

---

## 4. Service Code — Flow and Dependencies

### 4.1 Evaluate day (evaluation.controller.js)

1. **Validate** dayId, userId.
2. **HTTP GET** Daily Execution `/internal/day/:dayId/summary` (requires `DAILY_EXECUTION_URL`, optional `X-Service-Key`). Used for response shape and for `daySummary.date` when notifying Scheduler.
3. **EXEC USP_EVALUATE_DAY** (SP reads from DAILY_EXECUTION.dbo; writes only to DISCIPLINE_RULE_ENGINE).
4. **HTTP POST** Daily Execution `/internal/day/:dayId/result` with `result`, `evaluatedAt`, `totalRequired`, `totalCompleted` (and optionally `missedRules`) so Daily Execution persists the verdict.
5. **HTTP POST** Notification service `/send` (VERDICT_READY) — requires `NOTIFICATION_SERVICE_URL`.
6. If Minimum Mode or Recovery triggered: **HTTP POST** Scheduler `webhook/mode-change` — requires `SCHEDULER_SERVICE_URL`.

### 4.2 Stats (stats.controller.js)

- **Week:** `EXEC USP_GET_WEEK_STATISTICS`; parses multiple result sets (summary, daily, domain, pattern). Query: `userId`, `startDate` (SP expects `@WEEKSTARTDATE`).
- **Streak:** `EXEC USP_GET_STREAK_STATISTICS`; parses streak summary, milestones, next milestone, recent streaks.
- **Overall:** `EXEC USP_GET_OVERALL_STATISTICS`; parses period, performance, streak, average streak, mode distribution, domain performance, 7/30-day trend, achievements.
- **Mode history:** `EXEC USP_GET_MODE_CHANGE_HISTORY`; parses current status, history, mode distribution, recent periods.

**Result set parsing:** All controllers assume Sequelize RAW returns an array of result sets; they often use only `result[0]` and distinguish row types by column presence (e.g. `EvaluationId`, `CurrentStreak`). USP_EVALUATE_DAY and others return **multiple** SELECTs. Verify that `result[0]`, `result[1]`, … correspond to the SP’s result set order (e.g. status in [0], evaluation in [1], streak in [2]). If Sequelize flattens or merges sets, parsing may need adjustment.

---

## 5. Gaps / Recommendations

### 5.1 Configuration

- **database.js:** Host and credentials are hardcoded. Move to env (e.g. `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
- **Port:** Use `process.env.PORT || 5002` so deployment can override.
- **Env required for evaluate flow:** `DAILY_EXECUTION_URL` (e.g. `http://localhost:5001` or gateway URL), `NOTIFICATION_SERVICE_URL`, `SCHEDULER_SERVICE_URL`, `INTERNAL_SERVICE_KEY` (if those services require it).

### 5.2 Result set order (Sequelize RAW)

- USP_EVALUATE_DAY returns 7 result sets; USP_GET_WEEK_STATISTICS returns 4; USP_GET_STREAK_STATISTICS returns 4; etc. Confirm whether `sequelize.query(..., { type: QueryTypes.RAW })` returns `[rowsSet0, rowsSet1, ...]` and that controllers index the correct set for each payload (e.g. week summary vs daily breakdown). Document or add a test.

### 5.3 USERSTREAK creation

- USP_EVALUATE_DAY creates a USERSTREAK row if missing. USP_GET_MODE_CHANGE_HISTORY, USP_GET_OVERALL_STATISTICS, USP_GET_STREAK_STATISTICS, USP_GET_WEEK_STATISTICS return USER_NOT_FOUND if the user has no USERSTREAK. So a user with no evaluated days yet will get 404 from stats/mode-history until the first evaluation runs. Consider creating USERSTREAK on first day creation (e.g. in Scheduler or Daily Execution) or document that “stats require at least one evaluated day.”

### 5.4 RESULT terminology (BR-002)

- In API responses, map `result: 'FAIL'` to `result: 'Incomplete'` (or add `resultDisplay: 'Incomplete'`) for consistency with BRD.

### 5.5 Cross-database dependency

- DISCIPLINE_RULE_ENGINE SPs reference **DAILY_EXECUTION.dbo** and **RULE_MANAGEMENT.dbo**. Same server or linked server and permissions must be documented and configured in deployment.

### 5.6 DOMAINPERFORMANCE table

- Table exists but is not clearly populated by the provided SPs. USP_GET_WEEK_STATISTICS and USP_GET_OVERALL_STATISTICS compute domain performance from DAILY_EXECUTION.dbo on the fly. If DOMAINPERFORMANCE is intended for caching, add a job or SP to populate it; otherwise document as reserved for future use.

---

## 6. API Gateway Integration

**Done:**

- **Proxy:** Requests to `/discipline/*` are forwarded to Discipline Rule Engine (default `http://localhost:5002`) with `pathRewrite: { "^/discipline": "" }`.
- **Examples:**
  - `POST /discipline/internal/evaluate` — body: `{ "dayId", "userId", "triggeredBy?", "triggeredAt?" }` (Scheduler or internal client).
  - `GET /discipline/internal/stats/week?userId=1&startDate=2026-03-10`
  - `GET /discipline/internal/stats/streak?userId=1`
  - `GET /discipline/internal/stats/overall?userId=1`
  - `GET /discipline/internal/stats/mode-history?userId=1`

**Port:** Discipline Rule Engine runs on **5002** by default. Set `PORT=5002` in `.env` if needed.

**Service-to-service:** When the engine calls Daily Execution, it uses `DAILY_EXECUTION_URL`. Prefer direct service URL (e.g. `http://localhost:5001`) for server-to-server to avoid double gateway hop, unless all internal traffic must go through the gateway.

---

## 7. BRD / Flow Checklist

| BRD / flow item | Where it’s covered |
|-----------------|--------------------|
| Day evaluation after close | USP_EVALUATE_DAY; controller calls it after day close and syncs result to Daily Execution. |
| Binary verdict (Pass / Incomplete) | RESULT PASS/FAIL in DAYEVALUATIONAUDIT and USERDAY; map FAIL → Incomplete in API. |
| 3 consecutive failures → Minimum Mode | USP_EVALUATE_DAY inserts MODECHANGEHISTORY (FAILURE_THRESHOLD); controller notifies Scheduler. |
| 3 consecutive passes in Minimum → Recovery | USP_EVALUATE_DAY inserts MODECHANGEHISTORY (RECOVERY); controller notifies Scheduler. |
| Streaks (current, longest, milestones) | USERSTREAK; USP_GET_STREAK_STATISTICS, USP_GET_OVERALL_STATISTICS. |
| Week stats (pattern, domain performance) | USP_GET_WEEK_STATISTICS (uses DAILY_EXECUTION + RULE_MANAGEMENT). |
| Mode change history | MODECHANGEHISTORY; USP_GET_MODE_CHANGE_HISTORY. |

---

## 8. Next Steps

1. Move DB and port to env; document required env (DAILY_EXECUTION_URL, NOTIFICATION_SERVICE_URL, SCHEDULER_SERVICE_URL, INTERNAL_SERVICE_KEY).
2. Verify Sequelize RAW result set order for all SPs and fix parsing if needed.
3. Map RESULT FAIL → Incomplete in API responses (BR-002).
4. Document or implement USERSTREAK creation for users with no evaluations (or document that stats require at least one evaluated day).
5. Restrict or document `/discipline/internal/*` and enforce userId from token where applicable.
6. Document cross-database (DAILY_EXECUTION, RULE_MANAGEMENT) dependency for deployment.

---

*End of Discipline Rule Engine review. Service is integrated at `/discipline` and ready for use by the app and Scheduler.*
