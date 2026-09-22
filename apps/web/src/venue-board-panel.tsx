import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiClientError, formatCentsAsBeans, type TeacherApiClient } from "@teaching-research-alliance/client";

export type VenueBoardOption = Readonly<{ id: string; name: string; isOwn?: boolean }>;
export type VenueBoardWeek = Readonly<{ weekId: string; startsOn: string; endsOn: string; periodLabel?: string }>;
export type VenueBoardData = Readonly<{
  venue: Readonly<{ id: string; name: string; ownerNickname: string; canWithdraw: boolean; accountId?: string; balanceCents?: string }>;
  period: Readonly<{ teachingWeekId?: string; startsOn?: string; endsOn?: string }>;
  members: readonly Readonly<{ personId: string; nickname: string; canView: boolean; canWithdraw: boolean; isOwner: boolean }>[];
  teachers: readonly Readonly<{ teacherPersonId: string; teacherNickname: string; totalVenueFeeCents: string; weeklyFees: readonly Readonly<{ weeklyFeeEntryId: string; teachingWeekId: string; weekStartsOn: string; weekEndsOn: string; studentRecordId: string; studentDisplayName: string; courseContextId: string; venueFeeCents: string }>[] }>[];
  totalVenueFeeCents: string;
}>;

type Props = Readonly<{
  client: TeacherApiClient;
  venues: readonly VenueBoardOption[];
  weeks?: readonly VenueBoardWeek[];
  initialVenueId?: string | null | undefined;
  busy?: boolean;
}>;

export const boardErrorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === "FORBIDDEN_SCOPE" || error.code === "VENUE_NOT_FOUND") return "当前身份没有该场地看板权限。";
    if (error.code === "VENUE_DATA_UNAVAILABLE") return "场地看板数据暂时不可用，请稍后刷新。";
    if (error.code === "INVALID_INPUT") return "请选择完整的场地和筛选期间。";
  }
  return "场地看板读取失败，请稍后重试。";
};

export const summarizeVenueBoard = (board: VenueBoardData): Readonly<{ teacherCount: number; studentCount: number; totalVenueFeeCents: string }> => ({
  teacherCount: board.teachers.length,
  studentCount: board.teachers.reduce((count, teacher) => count + teacher.weeklyFees.length, 0),
  totalVenueFeeCents: board.totalVenueFeeCents
});

export function VenueBoardPanel({ client, venues, weeks = [], initialVenueId, busy = false }: Props): ReactNode {
  const [venueId, setVenueId] = useState(initialVenueId ?? venues[0]?.id ?? "");
  const [weekId, setWeekId] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [board, setBoard] = useState<VenueBoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialVenueId !== undefined && initialVenueId !== null) setVenueId(initialVenueId);
    else if (venues.length > 0 && !venues.some((venue) => venue.id === venueId)) setVenueId(venues[0]!.id);
  }, [initialVenueId, venues, venueId]);

  const selectedWeek = useMemo(() => weeks.find((week) => week.weekId === weekId), [weekId, weeks]);
  const loadBoard = async (): Promise<void> => {
    if (venueId === "") { setError("请选择场地看板。"); return; }
    if (weekId === "" && (startsOn === "" || endsOn === "")) { setError("请选择教学周，或填写起止日期。"); return; }
    if (weekId === "" && startsOn > endsOn) { setError("起始日期不能晚于结束日期。"); return; }
    setLoading(true); setError("");
    try {
      const next = await client.getVenueBoard<VenueBoardData>(venueId, weekId !== "" ? { teachingWeekId: weekId } : { startsOn, endsOn });
      setBoard(next);
    } catch (nextError) {
      setBoard(null); setError(boardErrorMessage(nextError));
    } finally { setLoading(false); }
  };

  const summary = board === null ? null : summarizeVenueBoard(board);
  return <section className="panel venue-board-panel" aria-label="共享场地看板">
    <div className="section-title"><div><span className="fee-eyebrow">VENUE BOARD</span><h2>共享场地看板</h2></div><span>{board?.venue.name ?? "按场地查看使用记录"}</span></div>
    <p className="venue-board-description">查看场地内授课老师、学生和每周实际场地费。查看权限不会显示账户余额，提现权限只显示该场地独立余额。</p>
    <div className="venue-board-filters">
      <label>场地<select aria-label="场地看板" value={venueId} disabled={busy || loading || initialVenueId !== undefined && initialVenueId !== null} onChange={(event) => { setVenueId(event.target.value); setBoard(null); }}>
        <option value="">请选择场地</option>{venues.map((venue) => <option value={venue.id} key={venue.id}>{venue.name}{venue.isOwn ? "（我的场地）" : ""}</option>)}
        {initialVenueId !== undefined && initialVenueId !== null && !venues.some((venue) => venue.id === initialVenueId) && <option value={initialVenueId}>当前场地</option>}
      </select></label>
      {weeks.length > 0 && <label>教学周<select aria-label="教学周" value={weekId} disabled={busy || loading} onChange={(event) => { setWeekId(event.target.value); setStartsOn(""); setEndsOn(""); }}>
        <option value="">按日期筛选</option>{weeks.map((week) => <option value={week.weekId} key={week.weekId}>{week.periodLabel ?? `${week.startsOn} 至 ${week.endsOn}`}</option>)}
      </select></label>}
      {weekId === "" && <><label>开始日期<input aria-label="开始日期" type="date" value={startsOn} disabled={busy || loading} onChange={(event) => setStartsOn(event.target.value)} /></label><label>结束日期<input aria-label="结束日期" type="date" value={endsOn} disabled={busy || loading} onChange={(event) => setEndsOn(event.target.value)} /></label></>}
      <button type="button" disabled={busy || loading} onClick={() => void loadBoard()}>{loading ? "正在读取…" : "查看看板"}</button>
    </div>
    {error !== "" && <p className="message" role="alert">{error}</p>}
    {board !== null && <>
      <div className="venue-board-summary">
        <div><span>场地总使用费</span><strong>{formatCentsAsBeans(summary!.totalVenueFeeCents)} 豆</strong></div>
        <div><span>授课老师</span><strong>{summary!.teacherCount} 人</strong></div>
        <div><span>学生课程记录</span><strong>{summary!.studentCount} 条</strong></div>
        {board.venue.canWithdraw && board.venue.balanceCents !== undefined && <div><span>场地可提现余额</span><strong>{formatCentsAsBeans(board.venue.balanceCents)} 豆</strong><small>提现入口沿用财务页面</small></div>}
      </div>
      <div className="venue-board-members"><h3>看板成员与权限</h3>{board.members.map((member) => <span key={member.personId}>{member.nickname} · {member.isOwner ? "所有者" : member.canWithdraw ? "查看＋提现" : member.canView ? "仅查看" : "无权限"}</span>)}</div>
      {board.teachers.length === 0 ? <p className="venue-board-empty">该期间暂无场地使用记录。</p> : <div className="venue-board-teachers">{board.teachers.map((teacher) => <article key={teacher.teacherPersonId}><div className="venue-board-teacher-heading"><div><h3>{teacher.teacherNickname}</h3><span>{teacher.weeklyFees.length} 条学生课程记录</span></div><strong>{formatCentsAsBeans(teacher.totalVenueFeeCents)} 豆</strong></div>{teacher.weeklyFees.map((fee) => <div className="venue-board-fee" key={fee.weeklyFeeEntryId}><div><b>{fee.studentDisplayName}</b><span>{fee.courseContextId} · {fee.weekStartsOn} 至 {fee.weekEndsOn}</span></div><strong>{formatCentsAsBeans(fee.venueFeeCents)} 豆</strong></div>)}</article>)}</div>}
    </>}
  </section>;
}
