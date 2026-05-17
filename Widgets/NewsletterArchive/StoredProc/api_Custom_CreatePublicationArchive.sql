-- ============================================================================
-- 03-create-sp-CreatePublicationArchive.sql
-- ----------------------------------------------------------------------------
-- Ingestion SP — called by PA flow "OscarHelpers - CPP - Newsletter Archive Intake"
-- when an email arrives at ministryplatform@archomaha.org.
--
-- Two source modes:
--   'MP-Native' — duplicate an existing Communication, retype to Newsletter Archive
--   'External'  — create fresh Communication from raw email fields
--
-- Output: @New_Communication_ID, also returned as a single-column resultset.
-- ============================================================================

SET NOCOUNT ON;

IF OBJECT_ID('dbo.api_Custom_CreatePublicationArchive', 'P') IS NOT NULL
    DROP PROCEDURE dbo.api_Custom_CreatePublicationArchive;
GO

CREATE PROCEDURE dbo.api_Custom_CreatePublicationArchive
    @DomainID                INT,
    @Source_Mode             NVARCHAR(20),                  -- 'MP-Native' | 'External'
    @Source_Communication_ID INT             = NULL,        -- required for MP-Native
    @Subject                 NVARCHAR(500)   = NULL,        -- required for External (optional override for MP-Native)
    @Body                    NVARCHAR(MAX)   = NULL,        -- required for External
    @Sender_Email            NVARCHAR(254)   = NULL,        -- External: used to resolve From_Contact
    @Sender_Name             NVARCHAR(100)   = NULL,        -- External: informational
    @Sent_Date               DATETIME        = NULL,        -- defaults to GETDATE()
    @Target_Publication_ID   INT             = NULL,        -- pass 'Unsorted' Publication_ID if no match
    @New_Communication_ID    INT             OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @PAUserID                INT = 147;             -- PowerAutomate User (sandbox + prod)
    DECLARE @PAContactID             INT;
    DECLARE @NewsletterArchiveTypeID INT;
    DECLARE @SentStatusID            INT;
    DECLARE @UnsortedPubID           INT;

    ------------------------------------------------------------------------
    -- Resolve PA Contact_ID, Newsletter Archive type, Sent status, Unsorted fallback
    ------------------------------------------------------------------------
    SELECT @PAContactID = Contact_ID
    FROM dbo.dp_Users
    WHERE User_ID = @PAUserID;

    IF @PAContactID IS NULL
    BEGIN
        RAISERROR('PA User (User_ID=147) not found or has no Contact_ID.', 16, 1);
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

    SELECT @SentStatusID = Communication_Status_ID
    FROM dbo.dp_Communication_Statuses
    WHERE Status = 'Sent';

    -- Fallback to Unsorted Publication if caller didn't specify a target
    IF @Target_Publication_ID IS NULL
    BEGIN
        SELECT @UnsortedPubID = Publication_ID
        FROM dbo.dp_Publications
        WHERE Name = 'Unsorted' AND Domain_ID = @DomainID;

        IF @UnsortedPubID IS NULL
        BEGIN
            RAISERROR('Unsorted Publication not configured. Run 02-seed-lookup-data.sql first.', 16, 1);
            RETURN;
        END
        SET @Target_Publication_ID = @UnsortedPubID;
    END

    SET @Sent_Date = ISNULL(@Sent_Date, GETDATE());

    ------------------------------------------------------------------------
    -- Branch on source mode
    ------------------------------------------------------------------------
    IF @Source_Mode = 'MP-Native'
    BEGIN
        IF @Source_Communication_ID IS NULL
        BEGIN
            RAISERROR('Source_Communication_ID required for MP-Native source.', 16, 1);
            RETURN;
        END

        INSERT INTO dbo.dp_Communications (
            Author_User_ID,
            Communication_Type_ID,
            Communication_Status_ID,
            Subject,
            Body,
            Domain_ID,
            From_Contact,
            Reply_to_Contact,
            Start_Date,
            Bulk_Email,
            Active,
            Publication_ID,
            Send_To_Parents,
            Template
        )
        SELECT
            @PAUserID,
            @NewsletterArchiveTypeID,
            @SentStatusID,
            COALESCE(@Subject, c.Subject),
            COALESCE(@Body, c.Body),
            @DomainID,
            c.From_Contact,                                  -- preserve original sender
            c.Reply_to_Contact,
            COALESCE(@Sent_Date, c.Start_Date),
            1,                                               -- Bulk_Email
            1,                                               -- Active
            @Target_Publication_ID,
            0,                                               -- Send_To_Parents
            0                                                -- Template
        FROM dbo.dp_Communications c
        WHERE c.Communication_ID = @Source_Communication_ID;

        SET @New_Communication_ID = SCOPE_IDENTITY();
    END
    ELSE IF @Source_Mode = 'External'
    BEGIN
        IF @Subject IS NULL OR @Body IS NULL
        BEGIN
            RAISERROR('Subject and Body required for External source.', 16, 1);
            RETURN;
        END

        -- Try resolve From_Contact by sender email; fall back to PA Contact
        DECLARE @From_Contact_ID INT;
        IF @Sender_Email IS NOT NULL
            SELECT TOP 1 @From_Contact_ID = Contact_ID
            FROM dbo.Contacts
            WHERE Email_Address = @Sender_Email;

        SET @From_Contact_ID = ISNULL(@From_Contact_ID, @PAContactID);

        INSERT INTO dbo.dp_Communications (
            Author_User_ID,
            Communication_Type_ID,
            Communication_Status_ID,
            Subject,
            Body,
            Domain_ID,
            From_Contact,
            Reply_to_Contact,
            Start_Date,
            Bulk_Email,
            Active,
            Publication_ID,
            Send_To_Parents,
            Template
        )
        VALUES (
            @PAUserID,
            @NewsletterArchiveTypeID,
            @SentStatusID,
            @Subject,
            @Body,
            @DomainID,
            @From_Contact_ID,
            @From_Contact_ID,
            @Sent_Date,
            1,                                               -- Bulk_Email
            1,                                               -- Active
            @Target_Publication_ID,
            0,                                               -- Send_To_Parents
            0                                                -- Template
        );

        SET @New_Communication_ID = SCOPE_IDENTITY();
    END
    ELSE
    BEGIN
        RAISERROR('Source_Mode must be ''MP-Native'' or ''External''.', 16, 1);
        RETURN;
    END

    -- Return as resultset for callers that don't bind OUTPUT params
    SELECT @New_Communication_ID AS Communication_ID;
END
GO

PRINT 'Created procedure api_Custom_CreatePublicationArchive.';
