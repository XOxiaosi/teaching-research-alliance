import assert from 'node:assert/strict';
import { Pool } from 'pg';

// Read only, exact API-issued IDs, disposable integration schemas only.
export async function bonusLedgerState({ fundId, recipientPersonId, financePersonId, documentId }) {
  const connection = process.env.ALLIANCE_DEMO_DATABASE_URL;
  assert.equal(process.env.ALLIANCE_SYNTHETIC_E2E, '1');
  assert.ok(connection && ['127.0.0.1', 'localhost'].includes(new URL(connection).hostname));
  const pool = new Pool({ connectionString: connection });
  try {
    const schemas = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^integration_[a-f0-9]{32}$'");
    const matches = [];
    for (const { nspname } of schemas.rows) {
      const table = await pool.query('SELECT to_regclass($1) AS name', [`${nspname}.company_finance_fund`]);
      if (!table.rows[0].name) continue;
      try {
        const found = await pool.query(`SELECT id FROM "${nspname}".company_finance_fund WHERE id=$1`, [fundId]);
        if (found.rowCount === 1) matches.push(nspname);
      } catch (error) {
        // Other integration tests may drop their own schema between discovery and this read.
        // The exact API fund must still identify one surviving schema below.
        if (!['42P01', '3F000'].includes(error.code)) throw error;
      }
    }
    assert.equal(matches.length, 1, 'exact API fund identifies one disposable demo schema');
    const schema = matches[0];
    const balances = await pool.query(`SELECT a.owner_type,a.owner_id::text,COALESCE(p.balance_cents,0)::text AS cents
      FROM "${schema}".settlement_account a LEFT JOIN "${schema}".account_balance_projection p ON p.account_id=a.id
      WHERE (a.owner_type='COMPANY' AND a.owner_id=$1) OR (a.owner_type='PERSON' AND a.owner_id IN ($2,$3))`, [fundId, recipientPersonId, financePersonId]);
    assert.equal(balances.rows.length, 3);
    const result = Object.fromEntries(balances.rows.map(row => [row.owner_id, row.cents]));
    const postings = documentId ? await pool.query(`SELECT t.finance_document_id::text,t.amount_cents::text,t.project_name,t.project_name_version_id::text,
      a.owner_type,a.owner_id::text,e.category_key,e.amount_cents::text AS entry_cents,d.status
      FROM "${schema}".project_bonus_transfer t JOIN "${schema}".finance_document d ON d.id=t.finance_document_id
      JOIN "${schema}".ledger_entry e ON e.event_id=t.ledger_event_id
      JOIN "${schema}".settlement_account a ON a.id=e.account_id WHERE t.finance_document_id=$1 ORDER BY e.category_key`, [documentId]) : { rows: [] };
    return { balances: result, postings: postings.rows };
  } finally { await pool.end(); }
}
