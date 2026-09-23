import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPORT_SCHEMA_REGISTRY} from '../dist/export-schema-registry.js';
import {createFullBackupLayout,backupSheetPartId,FULL_BACKUP_KNOWN_COVERAGE_GAPS} from '../dist/full-backup-layout.js';
test('every registered table has exactly one explicit group and secrets-only tables have no sheet',()=>{
 const items=createFullBackupLayout();assert.equal(items.length,79);assert.equal(new Set(items.map(item=>item.tableName)).size,79);
 assert.deepEqual(items.map(item=>item.tableName),EXPORT_SCHEMA_REGISTRY.map(table=>table.name));
 const secret=items.find(item=>item.tableName==='user_session');assert.equal(secret.sheetId,null);assert.equal(secret.policy,'AUTH_SECRET_TABLE_EXCLUDED');assert.ok(secret.excludedColumns.length>0);
 assert.throws(()=>backupSheetPartId(secret,1),/EXPORT_INVALID_SHEET_PART/);
 const names=items.filter(item=>item.sheetId!==null).map(item=>backupSheetPartId(item,9999));
 assert.equal(new Set(names).size,names.length);for(const name of names){assert.ok(name.length<=31);assert.doesNotMatch(name,/[:\\/?*\[\]]/);}
 assert.equal(items.some(item=>item.workbookId==='05'),false);assert.ok(FULL_BACKUP_KNOWN_COVERAGE_GAPS.includes('MONTHLY_INCOME_PUBLISHED_VERSIONS_NOT_IMPLEMENTED'));
 for(const part of [0,-1,1.5,10000,Infinity])assert.throws(()=>backupSheetPartId(items.find(item=>item.sheetId!==null),part),/EXPORT_INVALID_SHEET_PART/);
});
