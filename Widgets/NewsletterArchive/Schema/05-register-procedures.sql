-- ============================================================================
-- 05-register-procedures.sql
-- ----------------------------------------------------------------------------
-- Registers the two new SPs in MP's REST API gate.
--
-- Notes:
--   * api_Custom_CreatePublicationArchive — called by PA flow. Grant the role
--     PA's MP account holds (initially Administrators; can refine).
--   * api_Custom_GetMyNewsletterArchive — called by widget on behalf of any
--     authenticated user. Grant Administrators for sandbox testing first;
--     after smoke-test, grant the broader "Member" role used for engagement
--     tracking widget so any authenticated MP user can call it.
--
-- BEFORE RUNNING: verify column names on dp_API_Procedures. Adjust the INSERT
-- column list if MP's schema differs from this assumption.
-- ============================================================================

SET NOCOUNT ON;

DECLARE @DomainID  INT = 1;

------------------------------------------------------------------------
-- Register api_Custom_CreatePublicationArchive
------------------------------------------------------------------------
DECLARE @CreateSPID INT;

SELECT @CreateSPID = API_Procedure_ID
FROM dbo.dp_API_Procedures
WHERE Procedure_Name = 'api_Custom_CreatePublicationArchive';

IF @CreateSPID IS NULL
BEGIN
    INSERT INTO dbo.dp_API_Procedures (Procedure_Name, Description)
    VALUES (
        'api_Custom_CreatePublicationArchive',
        'PA flow ingestion target. Creates a Newsletter Archive Communication entry under a target Publication. Called by OscarHelpers - CPP - Newsletter Archive Intake.'
    );

    SET @CreateSPID = SCOPE_IDENTITY();
    PRINT CONCAT('Registered api_Custom_CreatePublicationArchive. API_Procedure_ID = ', @CreateSPID);
END
ELSE
    PRINT CONCAT('api_Custom_CreatePublicationArchive already registered. API_Procedure_ID = ', @CreateSPID);

------------------------------------------------------------------------
-- Register api_Custom_GetMyNewsletterArchive
------------------------------------------------------------------------
DECLARE @GetSPID INT;

SELECT @GetSPID = API_Procedure_ID
FROM dbo.dp_API_Procedures
WHERE Procedure_Name = 'api_Custom_GetMyNewsletterArchive';

IF @GetSPID IS NULL
BEGIN
    INSERT INTO dbo.dp_API_Procedures (Procedure_Name, Description)
    VALUES (
        'api_Custom_GetMyNewsletterArchive',
        'Widget SP. Returns the authenticated user''s accessible Newsletter Archive entries, gated by the visibility cascade (Targeted_Audience_ID then Congregation_ID then tenant-wide).'
    );

    SET @GetSPID = SCOPE_IDENTITY();
    PRINT CONCAT('Registered api_Custom_GetMyNewsletterArchive. API_Procedure_ID = ', @GetSPID);
END
ELSE
    PRINT CONCAT('api_Custom_GetMyNewsletterArchive already registered. API_Procedure_ID = ', @GetSPID);

------------------------------------------------------------------------
-- Grant Administrators role to both SPs (for sandbox testing)
------------------------------------------------------------------------
DECLARE @AdminRoleID INT;

SELECT @AdminRoleID = Role_ID
FROM dbo.dp_Roles
WHERE Role_Name = 'Administrators';

IF @AdminRoleID IS NULL
BEGIN
    RAISERROR('Administrators role not found.', 16, 1);
    RETURN;
END

IF NOT EXISTS (
    SELECT 1 FROM dbo.dp_Role_API_Procedures
    WHERE Role_ID = @AdminRoleID AND API_Procedure_ID = @CreateSPID
)
BEGIN
    INSERT INTO dbo.dp_Role_API_Procedures (Role_ID, API_Procedure_ID, Domain_ID)
    VALUES (@AdminRoleID, @CreateSPID, @DomainID);
    PRINT 'Granted Administrators -> api_Custom_CreatePublicationArchive.';
END

IF NOT EXISTS (
    SELECT 1 FROM dbo.dp_Role_API_Procedures
    WHERE Role_ID = @AdminRoleID AND API_Procedure_ID = @GetSPID
)
BEGIN
    INSERT INTO dbo.dp_Role_API_Procedures (Role_ID, API_Procedure_ID, Domain_ID)
    VALUES (@AdminRoleID, @GetSPID, @DomainID);
    PRINT 'Granted Administrators -> api_Custom_GetMyNewsletterArchive.';
END

PRINT '';
PRINT 'TODO post-sandbox-verification:';
PRINT '  1. Identify which Role corresponds to the broad "any authenticated MP user" set used by the Engagement Tracking widget on prod.';
PRINT '  2. Add a dp_Role_API_Procedures row for that Role -> api_Custom_GetMyNewsletterArchive.';
PRINT '  3. Identify which Role the PA flow''s MP account holds. If not Administrators, add a row for that Role -> api_Custom_CreatePublicationArchive.';

------------------------------------------------------------------------
-- Verification
------------------------------------------------------------------------
SELECT
    ap.API_Procedure_ID,
    ap.Procedure_Name,
    r.Role_Name
FROM dbo.dp_Role_API_Procedures rap
INNER JOIN dbo.dp_API_Procedures ap ON ap.API_Procedure_ID = rap.API_Procedure_ID
INNER JOIN dbo.dp_Roles           r  ON r.Role_ID            = rap.Role_ID
WHERE ap.Procedure_Name IN (
    'api_Custom_CreatePublicationArchive',
    'api_Custom_GetMyNewsletterArchive'
)
ORDER BY ap.Procedure_Name, r.Role_Name;
