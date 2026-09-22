import { useEffect, useState, type ReactNode } from "react";
import { formatCentsAsBeans, type TeacherApiClient } from "@teaching-research-alliance/client";
import { Button, Input, Picker, Text, View } from "@tarojs/components";
import { miniBoardErrorMessage, miniBoardSummary } from "./venue-board-helpers";

export type MiniVenueBoardOption = Readonly<{ id: string; name: string; isOwn?: boolean }>;
export type MiniVenueBoardWeek = Readonly<{ weekId: string; startsOn: string; endsOn: string; periodLabel?: string }>;
export type MiniVenueBoardData = Readonly<{
  venue: Readonly<{ id: string; name: string; ownerNickname: string; canWithdraw: boolean; accountId?: string; balanceCents?: string }>;
  members: readonly Readonly<{ personId: string; nickname: string; canView: boolean; canWithdraw: boolean; isOwner: boolean }>[];
  teachers: readonly Readonly<{ teacherPersonId: string; teacherNickname: string; totalVenueFeeCents: string; weeklyFees: readonly Readonly<{ weeklyFeeEntryId: string; teachingWeekId: string; weekStartsOn: string; weekEndsOn: string; studentRecordId: string; studentDisplayName: string; courseContextId: string; venueFeeCents: string }>[] }>[];
  totalVenueFeeCents: string;
}>;

type Props = Readonly<{ client: TeacherApiClient; venues: readonly MiniVenueBoardOption[]; weeks?: readonly MiniVenueBoardWeek[]; initialVenueId?: string | null | undefined; busy?: boolean }>;

export function VenueBoardPanel({ client, venues, weeks = [], initialVenueId, busy = false }: Props): ReactNode {
  const [venueId, setVenueId] = useState(initialVenueId ?? venues[0]?.id ?? "");
  const [weekId, setWeekId] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [board, setBoard] = useState<MiniVenueBoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { if (initialVenueId !== undefined && initialVenueId !== null) setVenueId(initialVenueId); else if (venues.length > 0 && !venues.some((venue) => venue.id === venueId)) setVenueId(venues[0]!.id); }, [initialVenueId, venues, venueId]);
  const loadBoard = async (): Promise<void> => {
    if (venueId === "") { setNotice("请选择场地看板。"); return; }
    if (weekId === "" && (startsOn === "" || endsOn === "")) { setNotice("请选择教学周，或填写起止日期。"); return; }
    if (weekId === "" && startsOn > endsOn) { setNotice("起始日期不能晚于结束日期。"); return; }
    setLoading(true); setNotice("");
    try { setBoard(await client.getVenueBoard<MiniVenueBoardData>(venueId, weekId !== "" ? { teachingWeekId: weekId } : { startsOn, endsOn })); } catch (error) { setBoard(null); setNotice(miniBoardErrorMessage(error)); } finally { setLoading(false); }
  };
  const summary = board === null ? null : miniBoardSummary(board);
  return <View className="panel venue-board-panel"><Text className="panel-title">共享场地看板</Text><Text className="panel-description">查看场地内授课老师、学生和每周场地费。查看权限不会显示账户余额。</Text>
    <Text className="field-label">场地</Text><Picker mode="selector" range={venues.map((venue) => `${venue.name}${venue.isOwn ? "（我的场地）" : ""}`)} value={Math.max(venues.findIndex((venue) => venue.id === venueId), 0)} disabled={busy || loading || initialVenueId !== undefined && initialVenueId !== null} onChange={(event) => { setVenueId(venues[Number(event.detail.value)]?.id ?? ""); setBoard(null); }}><View className="picker-value"><Text>{board?.venue.name ?? venues.find((venue) => venue.id === venueId)?.name ?? (initialVenueId ? "当前场地" : "请选择场地")}</Text><Text>⌄</Text></View></Picker>
    {weeks.length > 0 && <><Text className="field-label">教学周</Text><Picker mode="selector" range={["按日期筛选", ...weeks.map((week) => week.periodLabel ?? `${week.startsOn} 至 ${week.endsOn}`)]} value={weekId === "" ? 0 : Math.max(weeks.findIndex((week) => week.weekId === weekId) + 1, 0)} disabled={busy || loading} onChange={(event) => { const week = weeks[Number(event.detail.value) - 1]; setWeekId(week?.weekId ?? ""); if (week) { setStartsOn(""); setEndsOn(""); } }}><View className="picker-value"><Text>{weeks.find((week) => week.weekId === weekId)?.periodLabel ?? (weekId ? "已选教学周" : "按日期筛选")}</Text><Text>⌄</Text></View></Picker></>}
    {weekId === "" && <><Text className="field-label">开始日期</Text><Input className="text-input" type="text" value={startsOn} placeholder="YYYY-MM-DD" disabled={busy || loading} onInput={(event) => setStartsOn(event.detail.value)} /><Text className="field-label">结束日期</Text><Input className="text-input" type="text" value={endsOn} placeholder="YYYY-MM-DD" disabled={busy || loading} onInput={(event) => setEndsOn(event.detail.value)} /></>}
    <Button className="primary-button" disabled={busy || loading} onClick={() => void loadBoard()}>{loading ? "正在读取…" : "查看看板"}</Button>
    {notice !== "" && <View className="notice"><Text>{notice}</Text></View>}
    {board !== null && <><View className="venue-board-summary"><View><Text>场地总使用费</Text><Text>{formatCentsAsBeans(board.totalVenueFeeCents)} 豆</Text></View><View><Text>授课老师</Text><Text>{summary!.teacherCount} 人</Text></View><View><Text>学生课程记录</Text><Text>{summary!.studentCount} 条</Text></View>{board.venue.canWithdraw && board.venue.balanceCents !== undefined && <View><Text>场地可提现余额</Text><Text>{formatCentsAsBeans(board.venue.balanceCents)} 豆</Text></View>}</View><View className="venue-board-members"><Text className="panel-title">看板成员与权限</Text>{board.members.map((member) => <Text key={member.personId}>{member.nickname} · {member.isOwner ? "所有者" : member.canWithdraw ? "查看＋提现" : member.canView ? "仅查看" : "无权限"}</Text>)}</View>{board.teachers.length === 0 ? <Text className="panel-description">该期间暂无场地使用记录。</Text> : board.teachers.map((teacher) => <View className="venue-board-teacher" key={teacher.teacherPersonId}><View className="venue-board-teacher-heading"><Text>{teacher.teacherNickname} · {teacher.weeklyFees.length} 条记录</Text><Text>{formatCentsAsBeans(teacher.totalVenueFeeCents)} 豆</Text></View>{teacher.weeklyFees.map((fee) => <View className="venue-board-fee" key={fee.weeklyFeeEntryId}><Text>{fee.studentDisplayName} · {fee.courseContextId} · {fee.weekStartsOn} 至 {fee.weekEndsOn}</Text><Text>{formatCentsAsBeans(fee.venueFeeCents)} 豆</Text></View>)}</View>)}</>}
  </View>;
}
