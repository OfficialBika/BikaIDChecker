import { table, integer, text, index } from 'sdk/db';

export const entityHistory = table('entity_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  field: text('field').notNull(),
  value: text('value').notNull(),
  observedAt: integer('observed_at').notNull()
}, (t) => ({
  lookupIdx: index('idx_entity_history_lookup').on(t.entityType, t.entityId, t.field, t.observedAt)
}));


export const resolverConfig = table('resolver_config', {
  id: integer('id').primaryKey(),
  apiKey: text('api_key').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export const accountNameHistory = table('account_name_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityId: text('entity_id').notNull(),
  rawText: text('raw_text').notNull(),
  namesJson: text('names_json').notNull(),
  usernamesJson: text('usernames_json').notNull(),
  fetchedAt: integer('fetched_at').notNull()
}, (t) => ({
  lookupIdx: index('idx_account_name_history_lookup').on(t.entityId, t.fetchedAt)
}));


export const legacySangmataHistory = table('sangmata_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityId: text('entity_id').notNull(),
  rawText: text('raw_text').notNull(),
  namesJson: text('names_json').notNull(),
  usernamesJson: text('usernames_json').notNull(),
  fetchedAt: integer('fetched_at').notNull()
}, (t) => ({
  lookupIdx: index('idx_sangmata_history_lookup').on(t.entityId, t.fetchedAt)
}));
