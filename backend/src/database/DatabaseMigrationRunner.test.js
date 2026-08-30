const MigrationRunner = require('./DatabaseMigrationRunner');

describe('DatabaseMigrationRunner', () => {
  test('legacy cleanup does not drop the global link import events table', () => {
    const cleanup = MigrationRunner._migrations.find(migration => migration.version === 5);

    expect(cleanup).toBeDefined();
    expect(cleanup.sql).not.toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+link_import_events/i);
    expect(cleanup.sql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+link_import_join_history/i);
  });

  test('campaign schema migration adds the fields and tables required by the campaign flow', () => {
    const campaignMigration = MigrationRunner._migrations.find(migration => migration.version === 6);

    expect(campaignMigration).toMatchObject({ name: 'add_campaign_schema_v1' });
    expect(campaignMigration.sql).toMatch(/ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_type/i);
    expect(campaignMigration.sql).toMatch(/CREATE TABLE IF NOT EXISTS campaign_targets/i);
    expect(campaignMigration.sql).toMatch(/CREATE TABLE IF NOT EXISTS campaign_logs/i);
    expect(campaignMigration.sql).toMatch(/CREATE TABLE IF NOT EXISTS campaign_exclusions/i);
  });
});
