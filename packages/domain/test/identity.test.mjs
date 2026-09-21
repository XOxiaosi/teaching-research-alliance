import test from "node:test";
import assert from "node:assert/strict";
import {
  activeRoleAssignments,
  assertAdminAssignmentActor,
  roleContextsFor,
  switchRoleContext
} from "../dist/index.js";

const date = (value) => new Date(`${value}T00:00:00.000Z`);

const assignments = [
  { personId: "teacher-1", subject: "TEACHING_TEACHER", scope: "SELF", validFrom: date("2026-01-01") },
  { personId: "teacher-1", subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", scopeId: "campus-1", validFrom: date("2026-01-01") },
  { personId: "teacher-1", subject: "GROUP_LEADER", scope: "ASSOCIATED_TEACHERS", validFrom: date("2026-02-01") },
  { personId: "teacher-1", subject: "CAMPUS_PRINCIPAL", scope: "CAMPUS", scopeId: "campus-2", validFrom: date("2027-01-01") }
];

test("角色上下文按有效期筛选，不合并未来职责", () => {
  const active = activeRoleAssignments("teacher-1", assignments, date("2026-06-01"));
  assert.equal(active.length, 3);
  assert.equal(roleContextsFor("teacher-1", assignments, date("2026-06-01")).length, 3);
  assert.equal(switchRoleContext("teacher-1", "CAMPUS_PRINCIPAL", assignments, date("2026-06-01")).campusId, "campus-1");
  assert.throws(() => switchRoleContext("teacher-1", "HEADQUARTERS_FINANCE", assignments, date("2026-06-01")), /ROLE_CONTEXT_NOT_ASSIGNED/);
});

test("只有系统所有者能管理管理员身份", () => {
  assert.equal(assertAdminAssignmentActor(["SYSTEM_OWNER"]), "SYSTEM_OWNER");
  assert.throws(() => assertAdminAssignmentActor(["SYSTEM_ADMIN"]), /ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN/);
  assert.throws(() => assertAdminAssignmentActor(["CAMPUS_PRINCIPAL"]), /ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN/);
});
