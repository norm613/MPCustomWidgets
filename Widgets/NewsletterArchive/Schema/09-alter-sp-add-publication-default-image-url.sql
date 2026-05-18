-- ============================================================================
-- 09-alter-sp-add-publication-default-image-url.sql
-- ----------------------------------------------------------------------------
-- Adds a separate result column `Publication_Default_Image_URL` to
-- api_Custom_GetMyNewsletterArchive. This column resolves the dp_Files
-- attached to the row's Publication record (Page_ID dp_Publications) ONLY —
-- no fallback to Unsorted Pub or Domain. Bypasses the per-Publication
-- Use_First_Body_Image_For_Featured opt-out flag (the opt-out only affects
-- the per-row Featured_Image_URL cascade; the Pub default image is still
-- the Pub's identity image and is needed independently for sidebar avatars).
--
-- Use case: the widget's left sidebar uses this URL as a small square
-- "logo" for each Publication in the filter list. Falls back to a
-- first-letter avatar client-side if the URL is NULL.
--
-- Idempotent: ALTER PROCEDURE replaces the existing body wholesale.
--
-- After applying: `Publication_Default_Image_URL` becomes available to
-- any consumer of the SP (currently just the Newsletter Archive widget).
-- ============================================================================

SET NOCOUNT ON;

IF OBJECT_ID('dbo.api_Custom_GetMyNewsletterArchive', 'P') IS NULL
BEGIN
    RAISERROR('api_Custom_GetMyNewsletterArchive does not exist. Run StoredProc/api_Custom_GetMyNewsletterArchive.sql first.', 16, 1);
    RETURN;
END
GO

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
        RAISERROR('dp_Pages lookup failed. Image cascade cannot run.', 16, 1);
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
        -- Featured image (per-row cascade) — unchanged from migration 08.
        CASE
            WHEN COALESCE(p.Use_First_Body_Image_For_Featured, 0) = 1 THEN NULL
            ELSE COALESCE(
                (SELECT TOP 1 @FileUrlPrefix + CAST(f1.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f1
                 WHERE f1.Page_ID  = @CommPageID
                   AND f1.Record_ID = c.Communication_ID
                   AND f1.Image_Width IS NOT NULL
                   AND COALESCE(f1.Publicly_Accessible, 1) = 1
                   AND f1.Domain_ID = @DomainID
                 ORDER BY f1.Default_Image DESC, f1.UTC_Date_Added DESC),
                (SELECT TOP 1 @FileUrlPrefix + CAST(f2.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f2
                 WHERE f2.Page_ID  = @PubPageID
                   AND f2.Record_ID = c.Publication_ID
                   AND f2.Image_Width IS NOT NULL
                   AND COALESCE(f2.Publicly_Accessible, 1) = 1
                   AND f2.Domain_ID = @DomainID
                 ORDER BY f2.Default_Image DESC, f2.UTC_Date_Added DESC),
                (SELECT TOP 1 @FileUrlPrefix + CAST(f3.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f3
                 WHERE f3.Page_ID  = @PubPageID
                   AND f3.Record_ID = @UnsortedPubID
                   AND f3.Image_Width IS NOT NULL
                   AND COALESCE(f3.Publicly_Accessible, 1) = 1
                   AND f3.Domain_ID = @DomainID
                 ORDER BY f3.Default_Image DESC, f3.UTC_Date_Added DESC),
                (SELECT TOP 1 @FileUrlPrefix + CAST(f4.Unique_Name AS NVARCHAR(36))
                 FROM dbo.dp_Files f4
                 WHERE f4.Page_ID  = @DomainPageID
                   AND f4.Record_ID = @DomainID
                   AND f4.Image_Width IS NOT NULL
                   AND COALESCE(f4.Publicly_Accessible, 1) = 1
                   AND f4.Domain_ID = @DomainID
                 ORDER BY f4.Default_Image DESC, f4.UTC_Date_Added DESC)
            )
        END                    AS Featured_Image_URL,
        -- NEW (Schema/09): Publication's own default image — Tier-2 lookup only,
        -- no per-Pub opt-out, no Unsorted/Domain fallback. Used by the widget
        -- sidebar as a square Pub-identity avatar. NULL if the Publication has
        -- no dp_Files attached; widget falls back to first-letter avatar.
        (SELECT TOP 1 @FileUrlPrefix + CAST(fp.Unique_Name AS NVARCHAR(36))
         FROM dbo.dp_Files fp
         WHERE fp.Page_ID  = @PubPageID
           AND fp.Record_ID = c.Publication_ID
           AND fp.Image_Width IS NOT NULL
           AND COALESCE(fp.Publicly_Accessible, 1) = 1
           AND fp.Domain_ID = @DomainID
         ORDER BY fp.Default_Image DESC, fp.UTC_Date_Added DESC)
                               AS Publication_Default_Image_URL
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

PRINT 'Migration 09 applied: api_Custom_GetMyNewsletterArchive now returns Publication_Default_Image_URL (Tier-2 only, for sidebar avatars).';
