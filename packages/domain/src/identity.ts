import type { PermissionScope, PermissionSubject, RoleContext, SystemAuthority } from "@teaching-research-alliance/contracts";

export type RoleAssignmentRecord = Readonly<{
  personId: string;
  subject: PermissionSubject;
  scope: PermissionScope;
  scopeId?: string;
  validFrom: Date;
  validTo?: Date;
}>;

const isActiveAt = (assignment: RoleAssignmentRecord, at: Date): boolean =>
  assignment.validFrom <= at && (assignment.validTo === undefined || at < assignment.validTo);

export const activeRoleAssignments = (
  personId: string,
  assignments: readonly RoleAssignmentRecord[],
  at: Date
): readonly RoleAssignmentRecord[] =>
  assignments.filter((assignment) => assignment.personId === personId && isActiveAt(assignment, at));

export const roleContextsFor = (
  personId: string,
  assignments: readonly RoleAssignmentRecord[],
  at: Date
): readonly RoleContext[] =>
  activeRoleAssignments(personId, assignments, at).map((assignment) => {
    const context: RoleContext = { subject: assignment.subject, personId };
    if (assignment.scopeId === undefined) return context;
    if (assignment.scope === "REGION") return { ...context, regionId: assignment.scopeId };
    if (assignment.scope === "CAMPUS") return { ...context, campusId: assignment.scopeId };
    if (assignment.scope === "VENUE") return { ...context, venueId: assignment.scopeId };
    return context;
  });

export const switchRoleContext = (
  personId: string,
  subject: PermissionSubject,
  assignments: readonly RoleAssignmentRecord[],
  at: Date
): RoleContext => {
  const context = roleContextsFor(personId, assignments, at).find((item) => item.subject === subject);
  if (!context) throw new Error("ROLE_CONTEXT_NOT_ASSIGNED");
  return context;
};

export const canManageAdminAssignments = (actorSubjects: readonly PermissionSubject[]): boolean =>
  actorSubjects.includes("SYSTEM_OWNER");

export const assertAdminAssignmentActor = (actorSubjects: readonly PermissionSubject[]): SystemAuthority => {
  if (!canManageAdminAssignments(actorSubjects)) throw new Error("ONLY_SYSTEM_OWNER_CAN_MANAGE_ADMIN");
  return "SYSTEM_OWNER";
};
