-- ============================================================================
-- 08-add-pub-use-body-image-flag.sql
-- ----------------------------------------------------------------------------
-- Adds a per-Publication override flag for the featured-image cascade.
-- When `dp_Publications.Use_First_Body_Image_For_Featured = 1`, the widget SP
-- returns NULL for `Featured_Image_URL` on entries in that Publication —
-- causing the widget to fall back to JS-side body extraction (first non-tiny
-- <img> in the email body).
--
-- Use case: AxiosHQ-style newsletters where the first inline body image is
-- the publication's canonical hero per issue (issue-specific, not series-
-- wide). The cascade's curated-default approach (one per Pub) would override
-- the per-issue heroes; this flag opts the Pub out of the cascade.
--
-- Set for: Brother's Keeper (Publication_ID = 14).
-- Future opt-ins (per Fr. Norman): toggle the bit per-Pub in MP UI.
--
-- Idempotent: safe to re-run.
-- Target: PROD (mp.archomaha.org).
-- ============================================================================

SET NOCOUNT ON;

------------------------------------------------------------------------
-- Step 1 — Add the column if missing
------------------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME   = 'dp_Publications'
      AND COLUMN_NAME  = 'Use_First_Body_Image_For_Featured'
)
BEGIN
    ALTER TABLE dbo.dp_Publications
        ADD Use_First_Body_Image_For_Featured BIT NULL;
    PRINT 'Added column dp_Publications.Use_First_Body_Image_For_Featured (BIT NULL).';
END
ELSE
BEGIN
    PRINT 'Column dp_Publications.Use_First_Body_Image_For_Featured already exists; skipping ADD.';
END
GO

------------------------------------------------------------------------
-- Step 2 — Flag Brother's Keeper (Pub 14) as opt-in for body extraction
------------------------------------------------------------------------
UPDATE dbo.dp_Publications
SET Use_First_Body_Image_For_Featured = 1
WHERE Publication_ID = 14
  AND COALESCE(Use_First_Body_Image_For_Featured, 0) = 0;

PRINT CONCAT('Updated Publication_ID 14 (Brother''s Keeper) — flag set. Rows affected: ', @@ROWCOUNT);
GO

------------------------------------------------------------------------
-- Step 3 — Alter the SP to honor the flag
-- Wraps the existing 4-tier COALESCE in a CASE that returns NULL when the
-- Publication has the flag set, forcing widget body-extraction fallback.
------------------------------------------------------------------------
ALTER PROCEDURE dbo.api_Custom_GetMyNewsletterArchive
    @DomainID         INT,
    @Username         NVARCHAR(254),
    @Search           NVARCHAR(255) = NULL,
    @Publication_ID   INT           = NULL,
    @Max_Results      INT           = 100,
    @Offset           INT           = 0
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @UserContactID           INT;
    DECLARE @UserCongregationID      INT;
    DECLARE @NewsletterArchiveTypeID INT;
    DECLARE @CommPageID              INT;
    DECLARE @PubPageID               INT;
    DECLARE @DomainPageID            INT;
    DECLARE @UnsortedPubID           INT = 11;
    DECLARE @FileUrlPrefix           NVARCHAR(200) = 'https://mp.archomaha.org/ministryplatformapi/files/';

    SELECT @UserContactID       = u.Contact_ID,
           @UserCongregationID  = h.Congregation_ID
    FROM dbo.dp_Users u
    INNER JOIN dbo.Contacts c
        ON u.Contact_ID = c.Contact_ID
    LEFT JOIN dbo.Households h
        ON c.Household_ID = h.Household_ID
    WHERE u.User_Name = @Username
      AND u.Domain_ID = @DomainID;

    IF @UserContactID IS NULL
    BEGIN
        RAISERROR('User not found.', 16, 1);
        RETURN;
    END

    SELECT @NewsletterArchiveTypeID = Communication_Type_ID
    FROM dbo.dp_Communication_Types
    WHERE Communication_Type = 'Newsletter_Archive';

    IF @NewsletterArchiveTypeID IS NULL
    BEGIN
        RAISERROR('Newsletter_Archive Communication Type not found.', 16, 1);
        RETURN;
    END

    SELECT @CommPageID   = Page_ID FROM dbo.dp_Pages WHERE Table_Name = 'dp_Communications';
    SELECT @PubPageID    = Page_ID FROM dbo.dp_Pages WHERE Table_Name = 'dp_Publications';
    SELECT @DomainPageID = Page_ID FROM dbo.dp_Pages WHERE Table_Name = 'dp_Domains';

    IF @CommPageID IS NULL OR @PubPageID IS NULL OR @DomainPageID IS NULL
    BEGIN
        RAISERROR('dp_Pages lookup failed. Cascade cannot run.', 16, 1);
        RETURN;
    END

    DECLARE @UserAudiences TABLE (Audience_ID INT PRIMARY KEY);
    INSERT INTO @UserAudiences (Audience_ID)
    SELECT DISTINCT am.Audience_ID
    FROM dbo.Audience_Members am
    INNER JOIN dbo.Audiences a ON a.Audience_ID = am.Audience_ID
    WHERE am.Contact_ID = @UserContactID
      AND a.Active = 1
      AND a.Domain_ID = @DomainID;

    SELECT
        c.Communication_ID,
        c.Subject,
        c.Body,
        c.Start_Date           AS Sent_Date,
        c.From_Contact,
        fc.Display_Name        AS From_Display_Name,
        fc.Email_Address       AS From_Email,
        p.Publication_ID,
        p.Title                AS Publication_Title,
        p.Description          AS Publication_Description,
        p.Available_Online,
        p.Congregation_ID,
        p.Targeted_Audience_ID,
        CASE
            WHEN p.Targeted_Audience_ID IS NOT NULL THEN 'Audience'
            WHEN p.Congregation_ID    IS NOT NULL THEN 'Congregation'
            ELSE 'Tenant-Wide'
        END                    AS Visibility_Tier,
        -- Featured image: per-Publication opt-out wrapper around the 4-tier cascade.
        -- When p.Use_First_Body_Image_For_Featured = 1, return NULL so the widget
        -- falls back to JS-side body extraction (first non-tiny <img> in the email
        -- HTML). Otherwise run the curated 4-tier cascade as before.
        CASE
            WHEN COALESCE(p.Use_First_Body_Image_For_Featured, 0) = 1 THEN NULL
            ELSE COALESCE(
                -- Tier 1: this Communication's attached image files
                (SELECT TOP 1 @FileUrlPrefix + CAST(f1.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f1
                 WHERE f1.Page_ID  = @CommPageID
                   AND f1.Record_ID = c.Communication_ID
                   AND f1.Image_Width IS NOT NULL
                   AND COALESCE(f1.Publicly_Accessible, 1) = 1
                   AND f1.Domain_ID = @DomainID
                 ORDER BY f1.Default_Image DESC, f1.UTC_Date_Added DESC),
                -- Tier 2: this Communication's Publication's attached image files
                (SELECT TOP 1 @FileUrlPrefix + CAST(f2.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f2
                 WHERE f2.Page_ID  = @PubPageID
                   AND f2.Record_ID = c.Publication_ID
                   AND f2.Image_Width IS NOT NULL
                   AND COALESCE(f2.Publicly_Accessible, 1) = 1
                   AND f2.Domain_ID = @DomainID
                 ORDER BY f2.Default_Image DESC, f2.UTC_Date_Added DESC),
                -- Tier 3: Unsorted Publication's attached image files
                (SELECT TOP 1 @FileUrlPrefix + CAST(f3.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f3
                 WHERE f3.Page_ID  = @PubPageID
                   AND f3.Record_ID = @UnsortedPubID
                   AND f3.Image_Width IS NOT NULL
                   AND COALESCE(f3.Publicly_Accessible, 1) = 1
                   AND f3.Domain_ID = @DomainID
                 ORDER BY f3.Default_Image DESC, f3.UTC_Date_Added DESC),
                -- Tier 4: Domain record's attached image files
                (SELECT TOP 1 @FileUrlPrefix + CAST(f4.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f4
                 WHERE f4.Page_ID  = @DomainPageID
                   AND f4.Record_ID = @DomainID
                   AND f4.Image_Width IS NOT NULL
                   AND COALESCE(f4.Publicly_Accessible, 1) = 1
                   AND f4.Domain_ID = @DomainID
                 ORDER BY f4.Default_Image DESC, f4.UTC_Date_Added DESC)
            )
        END                    AS Featured_Image_URL
    FROM dbo.dp_Communications c
    INNER JOIN dbo.dp_Publications p
        ON p.Publication_ID = c.Publication_ID
    LEFT JOIN dbo.Contacts fc
        ON fc.Contact_ID = c.From_Contact
    WHERE c.Communication_Type_ID = @NewsletterArchiveTypeID
      AND c.Active = 1
      AND c.Domain_ID = @DomainID
      AND (@Publication_ID IS NULL OR c.Publication_ID = @Publication_ID)
      AND (
          @Search IS NULL
          OR c.Subject LIKE '%' + @Search + '%'
          OR c.Body    LIKE '%' + @Search + '%'
      )
      AND (
          CASE
              WHEN p.Targeted_Audience_ID IS NOT NULL THEN
                  CASE WHEN p.Targeted_Audience_ID IN (SELECT Audience_ID FROM @UserAudiences) THEN 1 ELSE 0 END
              WHEN p.Congregation_ID IS NOT NULL THEN
                  CASE WHEN p.Congregation_ID = @UserCongregationID THEN 1 ELSE 0 END
              ELSE 1
          END = 1
      )
    ORDER BY c.Start_Date DESC
    OFFSET @Offset ROWS
    FETCH NEXT @Max_Results ROWS ONLY;
END
GO

PRINT 'Altered api_Custom_GetMyNewsletterArchive — honors Use_First_Body_Image_For_Featured flag.';

------------------------------------------------------------------------
-- Step 4 — Verify
------------------------------------------------------------------------
SELECT Publication_ID, Title, Name, Use_First_Body_Image_For_Featured
FROM dbo.dp_Publications
WHERE Publication_ID = 14
   OR Use_First_Body_Image_For_Featured = 1
ORDER BY Publication_ID;
