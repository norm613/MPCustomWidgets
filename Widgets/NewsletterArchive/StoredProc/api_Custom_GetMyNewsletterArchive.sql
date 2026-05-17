-- ============================================================================
-- 04-create-sp-GetMyNewsletterArchive.sql
-- ----------------------------------------------------------------------------
-- Widget SP — called from MPCustomWidgets with data-requireUser="true".
-- @Username is auto-populated by the widget framework from the authenticated
-- user's dp_Users.User_Name.
--
-- Returns the user's accessible Newsletter Archive Communications, applying
-- the visibility cascade only:
--   1) Targeted_Audience_ID set -> user must be in that Audience
--   2) Else Congregation_ID set -> user's Household.Congregation_ID must match
--   3) Else both NULL -> any authenticated user sees it
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

    -- Newsletter_Archive Communication_Type_ID = 5 in both sandbox + prod
    SELECT @NewsletterArchiveTypeID = Communication_Type_ID
    FROM dbo.dp_Communication_Types
    WHERE Communication_Type = 'Newsletter_Archive';

    IF @NewsletterArchiveTypeID IS NULL
    BEGIN
        RAISERROR('Newsletter_Archive Communication Type not found (expected ID = 5).', 16, 1);
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
    -- Main query — visibility cascade + subscription gate
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
        -- Surface the "why I can see this" path for debug/UX:
        CASE
            WHEN p.Targeted_Audience_ID IS NOT NULL THEN 'Audience'
            WHEN p.Congregation_ID    IS NOT NULL THEN 'Congregation'
            ELSE 'Tenant-Wide'
        END                    AS Visibility_Tier
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

PRINT 'Created procedure api_Custom_GetMyNewsletterArchive.';
