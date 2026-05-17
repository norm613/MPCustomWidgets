-- ============================================================================
-- 01-add-targeted-audience-column.sql
-- ----------------------------------------------------------------------------
-- Adds Targeted_Audience_ID custom column to dp_Publications.
-- Applies only to the Custom Newsletter Archive Widget.
-- Restricts visibility of archived Communications under a Publication to
-- members of the specified Audience. NULL = fall through to Congregation_ID;
-- both NULL = visible to any authenticated user.
--
-- Idempotent: re-runnable without side effects.
-- ============================================================================

SET NOCOUNT ON;

-- 1) Add column if it doesn't exist
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.dp_Publications')
      AND name = 'Targeted_Audience_ID'
)
BEGIN
    ALTER TABLE dbo.dp_Publications
        ADD Targeted_Audience_ID INT NULL;
    PRINT 'Added column Targeted_Audience_ID to dp_Publications.';
END
ELSE
    PRINT 'Column Targeted_Audience_ID already exists; skipping ADD.';
GO

-- 2) Add FK constraint if it doesn't exist
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'FK_dp_Publications_Targeted_Audience'
)
BEGIN
    ALTER TABLE dbo.dp_Publications
        ADD CONSTRAINT FK_dp_Publications_Targeted_Audience
        FOREIGN KEY (Targeted_Audience_ID)
        REFERENCES dbo.Audiences(Audience_ID);
    PRINT 'Added FK constraint FK_dp_Publications_Targeted_Audience.';
END
ELSE
    PRINT 'FK FK_dp_Publications_Targeted_Audience already exists; skipping.';
GO

-- 3) Add extended-property description on the column
IF NOT EXISTS (
    SELECT 1 FROM sys.extended_properties
    WHERE major_id = OBJECT_ID('dbo.dp_Publications')
      AND minor_id = COLUMNPROPERTY(OBJECT_ID('dbo.dp_Publications'), 'Targeted_Audience_ID', 'ColumnId')
      AND name = 'MS_Description'
)
BEGIN
    EXEC sys.sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'Applies only to the Custom Newsletter Archive Widget. Restricts visibility of archived Communications under this Publication to members of the specified Audience. NULL falls through to Congregation_ID gating; if both NULL, surfaces to any authenticated user.',
        @level0type = N'SCHEMA', @level0name = N'dbo',
        @level1type = N'TABLE',  @level1name = N'dp_Publications',
        @level2type = N'COLUMN', @level2name = N'Targeted_Audience_ID';
    PRINT 'Added extended-property description to Targeted_Audience_ID.';
END
ELSE
    PRINT 'Extended-property description already exists; skipping.';
GO

-- 4) Verify
SELECT
    c.name                                       AS Column_Name,
    t.name                                       AS Data_Type,
    c.is_nullable                                AS Nullable,
    fk.name                                      AS FK_Name,
    OBJECT_NAME(fk.referenced_object_id)         AS References_Table,
    ep.value                                     AS Description
FROM sys.columns c
LEFT JOIN sys.types t
    ON c.user_type_id = t.user_type_id
LEFT JOIN sys.foreign_key_columns fkc
    ON fkc.parent_object_id = c.object_id
   AND fkc.parent_column_id = c.column_id
LEFT JOIN sys.foreign_keys fk
    ON fk.object_id = fkc.constraint_object_id
LEFT JOIN sys.extended_properties ep
    ON ep.major_id = c.object_id
   AND ep.minor_id = c.column_id
   AND ep.name = 'MS_Description'
WHERE c.object_id = OBJECT_ID('dbo.dp_Publications')
  AND c.name = 'Targeted_Audience_ID';
