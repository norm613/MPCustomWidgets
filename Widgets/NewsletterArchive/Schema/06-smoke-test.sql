-- ============================================================================
-- 06-smoke-test.sql
-- ----------------------------------------------------------------------------
-- Post-deployment verification of Phase 3a.
-- Run end-to-end after scripts 01-05 complete in sandbox.
-- ============================================================================

SET NOCOUNT ON;

-- ----------------------------------------------------------------------------
-- 1) Schema verifications
-- ----------------------------------------------------------------------------
PRINT '== Schema checks ==';

SELECT 'Targeted_Audience_ID column exists' AS Check_Type, COUNT(*) AS Result
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.dp_Publications')
  AND name = 'Targeted_Audience_ID';
-- Expected: 1

SELECT 'FK to Audiences exists' AS Check_Type, COUNT(*) AS Result
FROM sys.foreign_keys
WHERE name = 'FK_dp_Publications_Targeted_Audience';
-- Expected: 1

SELECT 'Newsletter_Archive type exists (ID 5)' AS Check_Type, COUNT(*) AS Result
FROM dbo.dp_Communication_Types
WHERE Communication_Type = 'Newsletter_Archive'
  AND Communication_Type_ID = 5;
-- Expected: 1

SELECT 'Targeted Newsletter Audience exists' AS Check_Type, COUNT(*) AS Result
FROM dbo.Audiences
WHERE Audience_Name = 'Targeted Newsletter Audience';
-- Expected: 1

SELECT 'Unsorted Publication exists' AS Check_Type, COUNT(*) AS Result
FROM dbo.dp_Publications
WHERE Name = 'Unsorted';
-- Expected: 1

SELECT 'CreatePublicationArchive SP exists' AS Check_Type, COUNT(*) AS Result
FROM sys.procedures
WHERE name = 'api_Custom_CreatePublicationArchive';
-- Expected: 1

SELECT 'GetMyNewsletterArchive SP exists' AS Check_Type, COUNT(*) AS Result
FROM sys.procedures
WHERE name = 'api_Custom_GetMyNewsletterArchive';
-- Expected: 1

SELECT 'Both SPs registered in dp_API_Procedures' AS Check_Type, COUNT(*) AS Result
FROM dbo.dp_API_Procedures
WHERE Procedure_Name IN (
    'api_Custom_CreatePublicationArchive',
    'api_Custom_GetMyNewsletterArchive'
);
-- Expected: 2

-- ----------------------------------------------------------------------------
-- 2) Smoke test CreatePublicationArchive (MP-Native mode)
-- ----------------------------------------------------------------------------
PRINT '';
PRINT '== Smoke test: CreatePublicationArchive (MP-Native mode) ==';
PRINT 'Manually set @TestSourceCommID below before running this block.';

/*
DECLARE @TestSourceCommID INT = NULL;   -- SET to any existing Communication_ID
DECLARE @TestNewID        INT;

-- Resolve Unsorted Publication ID dynamically
DECLARE @UnsortedID INT;
SELECT @UnsortedID = Publication_ID FROM dbo.dp_Publications WHERE Name = 'Unsorted';

EXEC dbo.api_Custom_CreatePublicationArchive
    @DomainID                = 1,
    @Source_Mode             = 'MP-Native',
    @Source_Communication_ID = @TestSourceCommID,
    @Target_Publication_ID   = @UnsortedID,
    @New_Communication_ID    = @TestNewID OUTPUT;

SELECT 'New archive entry' AS Test, *
FROM dbo.dp_Communications
WHERE Communication_ID = @TestNewID;

-- Clean up after smoke test
-- DELETE FROM dbo.dp_Communications WHERE Communication_ID = @TestNewID;
*/
GO

-- ----------------------------------------------------------------------------
-- 3) Smoke test CreatePublicationArchive (External mode)
-- ----------------------------------------------------------------------------
PRINT '';
PRINT '== Smoke test: CreatePublicationArchive (External mode) ==';

/*
DECLARE @TestNewExtID INT;
DECLARE @UnsortedID   INT;
SELECT @UnsortedID = Publication_ID FROM dbo.dp_Publications WHERE Name = 'Unsorted';

EXEC dbo.api_Custom_CreatePublicationArchive
    @DomainID                = 1,
    @Source_Mode             = 'External',
    @Subject                 = 'Smoke Test - Vicar for Clergy Update',
    @Body                    = '<p>This is a smoke-test ingestion from an External source. Safe to delete.</p>',
    @Sender_Email            = 'sahastings@archomaha.org',
    @Sender_Name             = 'Fr. Scott Hastings',
    @Sent_Date               = NULL,
    @Target_Publication_ID   = @UnsortedID,
    @New_Communication_ID    = @TestNewExtID OUTPUT;

SELECT 'New external archive entry' AS Test, *
FROM dbo.dp_Communications
WHERE Communication_ID = @TestNewExtID;

-- Clean up
-- DELETE FROM dbo.dp_Communications WHERE Communication_ID = @TestNewExtID;
*/
GO

-- ----------------------------------------------------------------------------
-- 4) Smoke test GetMyNewsletterArchive
-- ----------------------------------------------------------------------------
PRINT '';
PRINT '== Smoke test: GetMyNewsletterArchive ==';
PRINT 'Manually set @TestUsername below.';

/*
EXEC dbo.api_Custom_GetMyNewsletterArchive
    @DomainID    = 1,
    @Username    = 'John.Norman',                              -- adjust to test user
    @Search      = NULL,
    @Publication_ID = NULL,
    @Max_Results = 25,
    @Offset      = 0;
*/
GO

-- ----------------------------------------------------------------------------
-- 5) Visibility cascade verification probes
-- ----------------------------------------------------------------------------
PRINT '';
PRINT '== Cascade probe — show all Publications by visibility tier ==';

SELECT
    Publication_ID,
    Title,
    Name,
    Available_Online,
    Congregation_ID,
    Targeted_Audience_ID,
    CASE
        WHEN Targeted_Audience_ID IS NOT NULL THEN 'Audience-gated'
        WHEN Congregation_ID      IS NOT NULL THEN 'Congregation-gated'
        ELSE 'Tenant-wide'
    END AS Visibility_Tier
FROM dbo.dp_Publications
WHERE Domain_ID = 1
ORDER BY Visibility_Tier, Title;
