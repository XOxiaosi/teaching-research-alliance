import { ApiClientError } from "@teaching-research-alliance/client";

export const miniBoardErrorMessage = (error: unknown): string => error instanceof ApiClientError && (error.code === "FORBIDDEN_SCOPE" || error.code === "VENUE_NOT_FOUND") ? "当前身份没有该场地看板权限。" : "场地看板读取失败，请稍后重试。";
export const miniBoardSummary = (board: Readonly<{ teachers: readonly Readonly<{ weeklyFees: readonly unknown[] }>[] }>): Readonly<{ teacherCount: number; studentCount: number }> => ({ teacherCount: board.teachers.length, studentCount: board.teachers.reduce((sum, teacher) => sum + teacher.weeklyFees.length, 0) });
