--==============================================================
-- PHASE 4 - ACHIEVEMENTS (DISCIPLINE_RULE_ENGINE)
-- Additive / idempotent. Safe to re-run.
--==============================================================
USE [DISCIPLINE_RULE_ENGINE]
GO

IF OBJECT_ID('dbo.ACHIEVEMENT_MASTER', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ACHIEVEMENT_MASTER (
        ACHIEVEMENTID INT IDENTITY(1,1) NOT NULL,
        CODE NVARCHAR(50) NOT NULL,
        NAME NVARCHAR(100) NOT NULL,
        DESCRIPTION NVARCHAR(500) NULL,
        TIER NVARCHAR(20) NOT NULL,
        CATEGORY NVARCHAR(30) NOT NULL,
        CRITERIAJSON NVARCHAR(MAX) NULL,
        ICON NVARCHAR(50) NULL,
        DISPLAYORDER INT NOT NULL,
        ISACTIVE BIT NOT NULL CONSTRAINT DF_AM_ISACTIVE DEFAULT (1),
        CREATEDDATE DATETIME2(7) NOT NULL CONSTRAINT DF_AM_CREATEDDATE DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_ACHIEVEMENT_MASTER PRIMARY KEY CLUSTERED (ACHIEVEMENTID),
        CONSTRAINT UQ_AM_CODE UNIQUE (CODE),
        CONSTRAINT CHK_AM_TIER CHECK (TIER IN ('BRONZE','SILVER','GOLD','PLATINUM','DIAMOND','LEGEND')),
        CONSTRAINT CHK_AM_CATEGORY CHECK (CATEGORY IN ('STREAK','CHALLENGE','CONSISTENCY','RECOVERY','LEARNING'))
    );
END
GO

IF OBJECT_ID('dbo.USER_ACHIEVEMENT', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.USER_ACHIEVEMENT (
        USERACHIEVEMENTID INT IDENTITY(1,1) NOT NULL,
        USERID INT NOT NULL,
        ACHIEVEMENTID INT NOT NULL,
        AWARDEDAT DATETIME2(7) NOT NULL CONSTRAINT DF_UA_AWARDEDAT DEFAULT (SYSUTCDATETIME()),
        CONTEXTJSON NVARCHAR(MAX) NULL,
        CONSTRAINT PK_USER_ACHIEVEMENT PRIMARY KEY CLUSTERED (USERACHIEVEMENTID),
        CONSTRAINT UQ_UA_USER_ACH UNIQUE (USERID, ACHIEVEMENTID),
        CONSTRAINT FK_UA_ACHIEVEMENT FOREIGN KEY (ACHIEVEMENTID)
            REFERENCES dbo.ACHIEVEMENT_MASTER (ACHIEVEMENTID)
    );
    CREATE NONCLUSTERED INDEX IX_UA_USER ON dbo.USER_ACHIEVEMENT (USERID, AWARDEDAT DESC);
END
GO

MERGE dbo.ACHIEVEMENT_MASTER AS T
USING (VALUES
    (N'STREAK_3', N'3-Day Streak', N'Three consecutive PASS days.', N'BRONZE', N'STREAK', N'{"streak":3}', N'flame', 10),
    (N'STREAK_7', N'7-Day Streak', N'A full week of consistency.', N'SILVER', N'STREAK', N'{"streak":7}', N'flame', 20),
    (N'STREAK_14', N'14-Day Streak', N'Two weeks locked in.', N'GOLD', N'STREAK', N'{"streak":14}', N'flame', 30),
    (N'STREAK_30', N'30-Day Streak', N'A month without breaking.', N'PLATINUM', N'STREAK', N'{"streak":30}', N'flame', 40),
    (N'STREAK_50', N'50-Day Streak', N'Fifty days of proof.', N'DIAMOND', N'STREAK', N'{"streak":50}', N'flame', 50),
    (N'STREAK_100', N'100-Day Streak', N'One hundred days. Legend territory.', N'LEGEND', N'STREAK', N'{"streak":100}', N'flame', 60),
    (N'CHALLENGE_STARTER', N'Starter Complete', N'Finished a 14-day challenge.', N'BRONZE', N'CHALLENGE', N'{"durationDays":14}', N'trophy', 110),
    (N'CHALLENGE_BUILDER', N'Builder Complete', N'Finished a 21-day challenge.', N'SILVER', N'CHALLENGE', N'{"durationDays":21}', N'trophy', 120),
    (N'CHALLENGE_MOMENTUM', N'Momentum Complete', N'Finished a 30-day challenge.', N'GOLD', N'CHALLENGE', N'{"durationDays":30}', N'trophy', 130),
    (N'CHALLENGE_DISCIPLINE', N'Discipline Complete', N'Finished a 45-day challenge.', N'PLATINUM', N'CHALLENGE', N'{"durationDays":45}', N'trophy', 140),
    (N'CHALLENGE_IRON', N'Iron Complete', N'Finished a 60-day challenge.', N'PLATINUM', N'CHALLENGE', N'{"durationDays":60}', N'trophy', 150),
    (N'CHALLENGE_MASTER', N'Master Complete', N'Finished a 90-day challenge.', N'DIAMOND', N'CHALLENGE', N'{"durationDays":90}', N'trophy', 160),
    (N'CHALLENGE_ELITE', N'Elite Complete', N'Finished a 180-day challenge.', N'DIAMOND', N'CHALLENGE', N'{"durationDays":180}', N'trophy', 170),
    (N'CHALLENGE_LEGEND', N'Legend Complete', N'Finished a 365-day challenge.', N'LEGEND', N'CHALLENGE', N'{"durationDays":365}', N'trophy', 180),
    (N'PASS_RATE_80', N'80% Consistency', N'80%+ pass rate over at least 7 days.', N'SILVER', N'CONSISTENCY', N'{"passRate":80,"minDays":7}', N'target', 210),
    (N'PERFECT_WEEK', N'Perfect Week', N'Seven consecutive PASS days in a week.', N'GOLD', N'CONSISTENCY', N'{"perfectDays":7}', N'calendar', 220),
    (N'RECOVERY_COMPLETE', N'Recovery Complete', N'Exited Minimum Mode back to Standard.', N'BRONZE', N'RECOVERY', N'{"mode":"STANDARD"}', N'shield', 310)
) AS S (CODE, NAME, DESCRIPTION, TIER, CATEGORY, CRITERIAJSON, ICON, DISPLAYORDER)
ON T.CODE = S.CODE
WHEN NOT MATCHED BY TARGET THEN
    INSERT (CODE, NAME, DESCRIPTION, TIER, CATEGORY, CRITERIAJSON, ICON, DISPLAYORDER, ISACTIVE)
    VALUES (S.CODE, S.NAME, S.DESCRIPTION, S.TIER, S.CATEGORY, S.CRITERIAJSON, S.ICON, S.DISPLAYORDER, 1);
GO
