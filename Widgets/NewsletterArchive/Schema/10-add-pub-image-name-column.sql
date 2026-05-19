-- ============================================================================
-- 10-add-pub-image-name-column.sql
-- ----------------------------------------------------------------------------
-- Adds Image_Name (Font Awesome icon name) to dp_Publications, mirroring
-- the column of the same name on dp_Pages. Each Publication gets its own
-- icon identifier — used by the Newsletter Archive widget as the per-Pub
-- sidebar avatar, replacing the prior dp_Files-based Publication-default-
-- image approach (introduced in migration 09).
--
-- Seeding: existing Publications are populated by reading dp_Pages.Image_Name
-- for the dp_Publications page row, falling back to 'fa-newspaper-o' if
-- dp_Pages has no value set. So every Pub starts with the same default,
-- and per-Pub overrides are a simple MP UI edit on the Publication record.
--
-- Idempotent: column add is guarded; seed only touches NULL rows.
--
-- The per-row Featured_Image_URL cascade in api_Custom_GetMyNewsletterArchive
-- is NOT affected by this migration — that's the per-entry thumbnail in the
-- widget's Expanded view, a separate concern from the sidebar avatar.
-- ============================================================================

SET NOCOUNT ON;

IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'dp_Publications'
      AND COLUMN_NAME = 'Image_Name'
)
BEGIN
    ALTER TABLE dbo.dp_Publications
        ADD Image_Name NVARCHAR(50) NULL;
    PRINT 'Added column dp_Publications.Image_Name (NVARCHAR(50) NULL).';
END
ELSE
    PRINT 'Column dp_Publications.Image_Name already exists. Skipping ALTER.';
GO

-- Seed all existing Publications with the page-level icon copied from
-- dp_Pages.Image_Name. Only touches rows where Image_Name IS NULL so
-- re-running this migration won't overwrite per-Pub customizations.
DECLARE @PubPageImageName NVARCHAR(50);

SELECT @PubPageImageName = Image_Name
FROM dbo.dp_Pages
WHERE Table_Name = 'dp_Publications';

DECLARE @SeedValue NVARCHAR(50) = ISNULL(@PubPageImageName, 'fa-newspaper-o');

PRINT CONCAT('Seeding existing Publications with Image_Name = ''', @SeedValue, '''.');

UPDATE dbo.dp_Publications
SET Image_Name = @SeedValue
WHERE Image_Name IS NULL;

PRINT CONCAT(@@ROWCOUNT, ' Publication rows seeded.');
GO

-- Verification
SELECT Publication_ID, Title, Image_Name
FROM dbo.dp_Publications
WHERE Domain_ID = 1
ORDER BY Publication_ID;
