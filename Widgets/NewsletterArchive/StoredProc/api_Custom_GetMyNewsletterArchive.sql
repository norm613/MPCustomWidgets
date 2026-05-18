-- ============================================================================
-- api_Custom_GetMyNewsletterArchive.sql
-- ----------------------------------------------------------------------------
-- Canonical CURRENT state of the widget-callable reader SP.
-- ----------------------------------------------------------------------------
-- This file represents the SP as it should exist after all Schema/ migrations
-- have been applied. For a fresh install, run this file (after running
-- Schema/01-02 to create the prerequisite column and seed data) instead of
-- chaining the historical Schema/04 + Schema/07 + Schema/08 ALTERs.
--
-- Migration history:
--   Phase 3a  Schema/04 — Initial CREATE (visibility cascade only)
--   Phase 3b  Schema/07 — Added Featured_Image_URL via 4-tier dp_Files cascade
--                         (Communication → Publication → Unsorted Pub → Domain)
--                         and per-tier filtering for Image_Width, COALESCE
--                         Publicly_Accessible, Domain_ID match.
--   Phase 3b  Schema/08 — Added Use_First_Body_Image_For_Featured per-Publication
--                         opt-out flag. Wraps the 4-tier COALESCE in CASE WHEN
--                         flag = 1 THEN NULL ELSE [cascade] END, forcing the
--                         widget to fall back to JS body-extraction for opted-in
--                         Publications (e.g., AxiosHQ-style newsletters where
--                         the first inline image is the issue's canonical hero).
--   Phase 3b  Schema/09 — Added Publication_Default_Image_URL column to the
--                         result set. Resolves the Publication's own attached
--                         image (Tier-2 lookup only, no fallback, no per-Pub
--                         opt-out). Used by the widget sidebar to render a
--                         small square Pub-identity avatar; falls back
--                         client-side to a first-letter avatar when NULL.
--
-- ----------------------------------------------------------------------------
-- Called from: MPCustomWidgets framework with data-requireUser="true".
-- @Username is auto-populated by the widget framework from the authenticated
-- user's dp_Users.User_Name (e.g., "John.Norman" at ArchO).
--
-- Visibility cascade (applies per row):
--   1) p.Targeted_Audience_ID set -> user must be in that Audience
--   2) Else p.Congregation_ID set -> user's Household.Congregation_ID must match
--   3) Else both NULL -> any authenticated user sees it
--
-- Featured-image cascade (per row, computed at SELECT time):
--   When p.Use_First_Body_Image_For_Featured = 1: return NULL (widget falls back
--     to JS body-extraction; suited for sources where the body's first inline
--     image is the canonical hero per-issue, like AxiosHQ).
--   Otherwise COALESCE in this order:
--     Tier 1: dp_Files attached to this Communication (Page_ID dp_Communications)
--     Tier 2: dp_Files attached to this Communication's Publication
--     Tier 3: dp_Files attached to the Unsorted Publication (Publication_ID = 11
--             at ArchO production)
--     Tier 4: dp_Files attached to the Domain record (Page_ID dp_Domains,
--             Record_ID = @DomainID)
--   Within each tier: Default_Image = 1 wins, otherwise newest by UTC_Date_Added.
--   Image-only filter via Image_Width IS NOT NULL.
--   COALESCE(Publicly_Accessible, 1) = 1 treats NULL as default-public.
--   Domain_ID filter ensures multi-tenant isolation.
--
-- NOTE: Publication.Available_Online and dp_Contact_Publications are NOT
-- consulted by this widget. Available_Online belongs to MP's native "My
-- Publications" subscription widget; dp_Contact_Publications is the
-- subscription state for that widget. The Newsletter Archive widget is a
-- separate concern with a separate (audience/congregation) gate.
--
-- @Search performs a LIKE on Subject + Body (FT-index optimization deferred).
-- ============================================================================

SET NOCOUNT ON;

IF OBJECT_ID('dbo.api_Custom_GetMyNewsletterArchive', 'P') IS NOT NULL
    DROP PROCEDURE dbo.api_Custom_GetMyNewsletterArchive;
GO

CREATE PROCEDURE dbo.api_Custom_GetMyNewsletterArchive
    @DomainID         INT,
    @Username         NVARCHAR(254),                          -- auto-populated by widget framework
    @Search           NVARCHAR(255) = NULL,                   -- optional substring search
    @Publication_ID   INT           = NULL,                   -- optional filter to one publication
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
    DECLARE @UnsortedPubID           INT = 11;                -- ArchO prod 'Unsorted' Publication_ID
    DECLARE @FileUrlPrefix           NVARCHAR(200) = 'https://mp.archomaha.org/ministryplatformapi/files/';
    -- ^^ Adjust @FileUrlPrefix per tenant. ArchO prod confirmed 2026-05-18: files
    -- served at /ministryplatformapi/files/{Unique_Name} (note "api" suffix on path).

    ------------------------------------------------------------------------
    -- Resolve user's Contact + Congregation
    --   Congregation lives on Households (not Contacts). Join chain:
    --   dp_Users -> Contacts -> Households (LEFT JOIN — Household_ID nullable)
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

    -- Newsletter_Archive Communication_Type_ID = 5 at ArchO (verify per tenant)
    SELECT @NewsletterArchiveTypeID = Communication_Type_ID
    FROM dbo.dp_Communication_Types
    WHERE Communication_Type = 'Newsletter_Archive';

    IF @NewsletterArchiveTypeID IS NULL
    BEGIN
        RAISERROR('Newsletter_Archive Communication Type not found.', 16, 1);
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
        RAISERROR('dp_Pages lookup failed. Image cascade cannot run.', 16, 1);
        RETURN;
    END

    ------------------------------------------------------------------------
    -- Snapshot user's current Audience memberships (Active audiences only)
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
        -- Featured image: per-Publication opt-out wrapper around the 4-tier cascade.
        -- When p.Use_First_Body_Image_For_Featured = 1, return NULL so the widget
        -- falls back to JS-side body extraction (first non-tiny <img> in body HTML;
        -- typically yields per-issue heroes from AxiosHQ-style newsletters).
        -- Otherwise run the curated 4-tier cascade.
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
                -- Tier 4: Domain record's attached image files (institutional fallback)
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
        -- Schema/09: Publication's own default image — Tier-2 lookup only,
        -- no per-Pub opt-out, no Unsorted/Domain fallback. Used by the widget
        -- sidebar as a square Pub-identity avatar. NULL if the Publication
        -- has no dp_Files attached; widget falls back to first-letter avatar.
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
      -- ----- Visibility cascade (the only gate) -----
      AND (
          CASE
              WHEN p.Targeted_Audience_ID IS NOT NULL THEN
                  CASE WHEN p.Targeted_Audience_ID IN (SELECT Audience_ID FROM @UserAudiences) THEN 1 ELSE 0 END
              WHEN p.Congregation_ID IS NOT NULL THEN
                  CASE WHEN p.Congregation_ID = @UserCongregationID THEN 1 ELSE 0 END
              ELSE 1                                          -- both NULL = any authenticated user
          END = 1
      )
    ORDER BY c.Start_Date DESC
    OFFSET @Offset ROWS
    FETCH NEXT @Max_Results ROWS ONLY;
END
GO

PRINT 'Created procedure api_Custom_GetMyNewsletterArchive (current canonical form, post-migration-09).';
