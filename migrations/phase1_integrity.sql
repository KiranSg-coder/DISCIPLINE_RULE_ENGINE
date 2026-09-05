--==============================================================
-- PHASE 1 - INTEGRITY FOUNDATION (DISCIPLINE_RULE_ENGINE)
-- Additive / idempotent. Safe to re-run.
-- Apply together with the updated stored procedure definitions
-- in storeprocedures.sql (CREATE OR ALTER):
--   USP_EVALUATE_DAY          (MINIMUM/RECOVERY threshold aligned to 3)
--   USP_GET_STREAK_STATISTICS (milestone CASE bug fixed)
--==============================================================
USE [DISCIPLINE_RULE_ENGINE]
GO

-- Missing index for per-user chronological audit reads (stats, achievements)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DAYEVAL_USER_DATE' AND object_id = OBJECT_ID('dbo.DAYEVALUATIONAUDIT'))
    CREATE NONCLUSTERED INDEX IX_DAYEVAL_USER_DATE
        ON dbo.DAYEVALUATIONAUDIT (USERID, DAYDATE)
        INCLUDE (RESULT, EVALUATIONMODE, CURRENTSTREAK, CONSECUTIVEFAILURES, COMPLETIONPERCENTAGE);
GO
