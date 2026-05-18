-- ============================================================================
-- 07-alter-sp-GetMyNewsletterArchive-image-cascade.sql
-- ----------------------------------------------------------------------------
-- Adds Featured_Image_URL to the widget SP's result set, resolved via a
-- 4-tier dp_Files cascade:
--
--   Tier 1: Files attached to THIS Communication
--           (Page_ID = dp_Communications, Record_ID = Communication_ID)
--   Tier 2: Files attached to the Communication's PUBLICATION
--           (Page_ID = dp_Publications, Record_ID = c.Publication_ID)
--   Tier 3: Files attached to the UNSORTED Publication (Publication_ID = 11)
--   Tier 4: Files attached to the DOMAIN record (Page_ID = dp_Domains,
--           Record_ID = @DomainID) — institutional default; guarantees a
--           non-null result whenever the Domain has any image attached.
--
-- Within each tier: Default_Image = 1 wins; otherwise newest Image by
-- Date_Added DESC.
--
-- Returns NULL only if all three tiers find no Image file; widget JS
-- falls back to HTML-body extraction in that case.
--
-- URL pattern confirmed for ArchO MP install (2026-05-18 by Fr. Norman):
--   https://mp.archomaha.org/ministryplatformapi/files/{Unique_Name}
-- Note: it's /ministryplatformapi/files/ (with the "api" suffix on the path),
-- NOT /ministryplatform/files/. MP serves files publicly via the API host,
-- keyed by the file's Unique_Name (uniqueidentifier).
--
-- Target: PROD (mp.archomaha.org) — sandbox doesn't replicate file blobs
-- so cascade testing only makes sense against prod.
-- ============================================================================

SET NOCOUNT ON;

IF OBJECT_ID('dbo.api_Custom_GetMyNewsletterArchive', 'P') IS NULL
BEGIN
    RAISERROR('api_Custom_GetMyNewsletterArchive does not exist. Run 04-create-sp-GetMyNewsletterArchive.sql first.', 16, 1);
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
    DECLARE @UnsortedPubID           INT = 11;          -- prod 'Unsorted' Publication_ID
    DECLARE @FileUrlPrefix           NVARCHAR(200) = 'https://mp.archomaha.org/ministryplatformapi/files/';

    ------------------------------------------------------------------------
    -- Resolve user's Contact + Congregation (unchanged from v1)
    ------------------------------------------------------------------------
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
        RAISERROR('Newsletter_Archive Communication Type not found (expected ID = 5).', 16, 1);
        RETURN;
    END

    ------------------------------------------------------------------------
    -- Resolve Page_IDs for the file-cascade subqueries
    -- (Page_IDs vary across MP installs; look up by canonical Table_Name)
    ------------------------------------------------------------------------
    SELECT @CommPageID   = Page_ID FROM dbo.dp_Pages WHERE Table_Name = 'dp_Communications';
    SELECT @PubPageID    = Page_ID FROM dbo.dp_Pages WHERE Table_Name = 'dp_Publications';
    SELECT @DomainPageID = Page_ID FROM dbo.dp_Pages WHERE Table_Name = 'dp_Domains';

    IF @CommPageID IS NULL OR @PubPageID IS NULL OR @DomainPageID IS NULL
    BEGIN
        RAISERROR('dp_Pages lookup failed for dp_Communications, dp_Publications, or dp_Domains. Cascade cannot run.', 16, 1);
        RETURN;
    END

    ------------------------------------------------------------------------
    -- User's Audience memberships (unchanged from v1)
    ------------------------------------------------------------------------
    DECLARE @UserAudiences TABLE (Audience_ID INT PRIMARY KEY);

    INSERT INTO @UserAudiences (Audience_ID)
    SELECT DISTINCT am.Audience_ID
    FROM dbo.Audience_Members am
    INNER JOIN dbo.Audiences a ON a.Audience_ID = am.Audience_ID
    WHERE am.Contact_ID = @UserContactID
      AND a.Active = 1
      AND a.Domain_ID = @DomainID;

    ------------------------------------------------------------------------
    -- Main query — visibility cascade + featured-image cascade
    ------------------------------------------------------------------------
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
        -- 4-tier featured-image cascade: Comm → Pub → Unsorted-Pub → Domain
        -- dp_Files schema notes:
        --   - Unique_Name is uniqueidentifier (GUID); CAST to NVARCHAR(36) for URL concat
        --   - Image-type filter via Image_Width IS NOT NULL (no Image boolean exists)
        --   - Publicly_Accessible = 1 required so <img src> works without auth
        --   - Date column is UTC_Date_Added (not Date_Added)
        COALESCE(
            -- Tier 1: this Communication's attached image files
            (SELECT TOP 1 @FileUrlPrefix + CAST(f1.Unique_Name AS NVARCHAR(36))
             FROM dbo.dp_Files f1
             WHERE f1.Page_ID  = @CommPageID
               AND f1.Record_ID = c.Communication_ID
               AND f1.Image_Width IS NOT NULL
               AND COALESCE(f1.Publicly_Accessible, 1) = 1   -- NULL = default-public; only 0 excludes
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
            -- Tier 4: Domain record's attached image files (institutional fallback)
            (SELECT TOP 1 @FileUrlPrefix + CAST(f4.Unique_Name AS NVARCHAR(36))
             FROM dbo.dp_Files f4
             WHERE f4.Page_ID  = @DomainPageID
               AND f4.Record_ID = @DomainID
               AND f4.Image_Width IS NOT NULL
               AND COALESCE(f4.Publicly_Accessible, 1) = 1
               AND f4.Domain_ID = @DomainID
             ORDER BY f4.Default_Image DESC, f4.UTC_Date_Added DESC)
        )                      AS Featured_Image_URL
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

PRINT 'Altered procedure api_Custom_GetMyNewsletterArchive — added Featured_Image_URL via 4-tier file cascade.';

-- ============================================================================
-- Smoke test: confirm the cascade resolves at least one tier.
-- Run as a user who's authenticated (substitute the @Username value).
-- ============================================================================
-- EXEC dbo.api_Custom_GetMyNewsletterArchive
--     @DomainID = 1,
--     @Username = 'John.Norman',
--     @Max_Results = 5;
