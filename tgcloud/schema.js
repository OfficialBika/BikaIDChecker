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
