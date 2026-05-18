-- ============================================================================
-- 02-seed-lookup-data.sql
-- ----------------------------------------------------------------------------
-- Verifies / seeds three lookup records the Newsletter Archive system needs:
--   1) dp_Communication_Types: 'Newsletter_Archive' (VERIFY only — pre-exists at ID 5)
--   2) Audiences:              'Targeted Newsletter Audience' (INSERT if missing)
--   3) dp_Publications:        'Unsorted' (INSERT if missing — PA flow fallback)
--
-- Idempotent: existing rows are detected and skipped.
-- ============================================================================

SET NOCOUNT ON;

DECLARE @DomainID  INT = 1;   -- ArchO domain
DECLARE @PAUserID  INT = 147; -- PowerAutomate User (sandbox + prod)

-- ----------------------------------------------------------------------------
-- 2a) Verify dp_Communication_Types: 'Newsletter_Archive'
--     Per Fr. Norman 2026-05-16: Communication_Type_ID = 5 in both
--     sandbox and prod. This block verifies and fails fast if missing.
-- ----------------------------------------------------------------------------
DECLARE @NewsletterArchiveTypeID INT;

SELECT @NewsletterArchiveTypeID = Communication_Type_ID
FROM dbo.dp_Communication_Types
WHERE Communication_Type = 'Newsletter_Archive';

IF @NewsletterArchiveTypeID IS NULL
BEGIN
    RAISERROR(
        'Newsletter_Archive Communication Type not found. Expected Communication_Type_ID = 5.',
        16, 1
    );
    RETURN;
END
ELSE
    PRINT CONCAT('Newsletter_Archive Communication Type verified. ID = ', @NewsletterArchiveTypeID);

-- ----------------------------------------------------------------------------
-- 2b) Audiences: 'Targeted Newsletter Audience'
--     Default Audience for the Unsorted Publication. Membership = CPP staff
--     who triage / target newsletter publications.
-- ----------------------------------------------------------------------------
DECLARE @TargetedNewsletterAudienceID INT;

SELECT @TargetedNewsletterAudienceID = Audience_ID
FROM dbo.Audiences
WHERE Audience_Name = 'Targeted Newsletter Audience' AND Domain_ID = @DomainID;

IF @TargetedNewsletterAudienceID IS NULL
BEGIN
    INSERT INTO dbo.Audiences (Domain_ID, Audience_Name, Description, Processing_Order, Active)
    VALUES (
        @DomainID,
        'Targeted Newsletter Audience',
        'CPP staff who target / triage newsletter publications. Gates the Unsorted Publication in the Newsletter Archive widget. Members see archive entries pending classification.',
        0,
        1
    );

    SET @TargetedNewsletterAudienceID = SCOPE_IDENTITY();
    PRINT CONCAT('Created Targeted Newsletter Audience. ID = ', @TargetedNewsletterAudienceID);
    PRINT 'NOTE: Add members via Audience_Members before going live.';
END
ELSE
    PRINT CONCAT('Targeted Newsletter Audience already exists. ID = ', @TargetedNewsletterAudienceID);

-- ----------------------------------------------------------------------------
-- 2c) dp_Publications: 'Unsorted'
-- ----------------------------------------------------------------------------
DECLARE @UnsortedPubID INT;

SELECT @UnsortedPubID = Publication_ID
FROM dbo.dp_Publications
WHERE Name = 'Unsorted' AND Domain_ID = @DomainID;

IF @UnsortedPubID IS NULL
BEGIN
    INSERT INTO dbo.dp_Publications (
        Domain_ID,
        Title,
        Name,
        Description,
        Moderator,
        Available_Online,
        Sync_Nightly,
        On_Connection_Card,
        Auto_Add_Heads,
        Enable_Auto_Subscribe,
        Targeted_Audience_ID
    )
    VALUES (
        @DomainID,
        'Unsorted',
        'Unsorted',
        'Catchall for PA-ingested Communications whose source could not be matched to an existing Publication. Triage by reassigning Publication_ID on the Communication record to the correct Publication.',
        @PAUserID,
        0,                                  -- Available_Online: No (not surfaced in MP's native My Publications subscription widget; irrelevant to the Newsletter Archive widget)
        0,                                  -- Sync_Nightly
        0,                                  -- On_Connection_Card
        0,                                  -- Auto_Add_Heads (ArchO custom)
        0,                                  -- Enable_Auto_Subscribe (ArchO custom)
        @TargetedNewsletterAudienceID       -- Visibility gated to Targeted Newsletter Audience
    );

    SET @UnsortedPubID = SCOPE_IDENTITY();
    PRINT CONCAT('Created Unsorted Publication. ID = ', @UnsortedPubID);
END
ELSE
    PRINT CONCAT('Unsorted Publication already exists. ID = ', @UnsortedPubID);

-- ----------------------------------------------------------------------------
-- Verification
-- ----------------------------------------------------------------------------
SELECT 'Communication_Type' AS Lookup, Communication_Type_ID AS ID, Communication_Type AS Name
FROM dbo.dp_Communication_Types
WHERE Communication_Type = 'Newsletter_Archive'

UNION ALL

SELECT 'Audience', Audience_ID, Audience_Name
FROM dbo.Audiences
WHERE Audience_Name = 'Targeted Newsletter Audience' AND Domain_ID = @DomainID

UNION ALL

SELECT 'Publication', Publication_ID, Title
FROM dbo.dp_Publications
WHERE Name = 'Unsorted' AND Domain_ID = @DomainID;
