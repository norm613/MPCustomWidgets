-- ============================================================================
-- 11-add-comm-omit-from-archive-column.sql
-- ----------------------------------------------------------------------------
-- Adds Omit_from_Archive BIT NOT NULL DEFAULT 0 to dp_Communications. This
-- column replaces the use of Active as the gate for whether a Communication
-- appears in the Newsletter Archive widget.
--
-- Rationale (established 2026-05-18 via audit-log investigation of
-- Communication 2992):
--
--   MP's Active column has dual semantics that conflict with the archive
--   widget's needs. MP treats Active as "in the active send queue" — when
--   a Communication is sent via MP's email pipeline, MP auto-deactivates
--   the record (Active flips 1 -> 0) as part of post-send cleanup. This
--   is normal MP behavior for the email-send subsystem.
--
--   But for an *archive*, "was sent in the past" is exactly what we want
--   to display. Filtering on Active = 1 was excluding every MP-UI-composed
--   newsletter that had been sent — which is most of them.
--
--   Omit_from_Archive is a separate, user-controlled flag with a single
--   semantic: "do not show this Communication in the Newsletter Archive
--   widget." Defaults to 0 (show) for every Communication, including
--   existing rows. Operators can flip it to 1 only when they need to
--   genuinely hide a record (recall, retraction, embargoed content).
--
-- Idempotent: column add guarded against re-run.
-- ============================================================================

SET NOCOUNT ON;

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'dp_Communications'
      AND COLUMN_NAME = 'Omit_from_Archive'
)
BEGIN
    ALTER TABLE dbo.dp_Communications
        ADD Omit_from_Archive BIT NOT NULL CONSTRAINT DF_dp_Communications_Omit_from_Archive DEFAULT (0);
    PRINT 'Added column dp_Communications.Omit_from_Archive (BIT NOT NULL DEFAULT 0).';
END
ELSE
    PRINT 'Column dp_Communications.Omit_from_Archive already exists. Skipping ALTER.';
GO

-- Verification: how many archive-classified Communications exist, broken
-- down by Active and Omit_from_Archive. Use this to spot-check the
-- transition: the SP's NEW filter (Omit_from_Archive = 0) should show
-- MORE rows than the OLD filter (Active = 1).
SELECT
    c.Communication_Type_ID,
    c.Active,
    c.Omit_from_Archive,
    COUNT(*) AS Row_Count
FROM dbo.dp_Communications c
INNER JOIN dbo.dp_Communication_Types ct
    ON ct.Communication_Type_ID = c.Communication_Type_ID
WHERE ct.Communication_Type = 'Newsletter_Archive'
  AND c.Domain_ID = 1
GROUP BY c.Communication_Type_ID, c.Active, c.Omit_from_Archive
ORDER BY c.Communication_Type_ID, c.Active, c.Omit_from_Archive;
