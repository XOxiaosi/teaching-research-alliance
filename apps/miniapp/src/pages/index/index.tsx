import { useRef, useState, type ReactNode } from "react";
import { Button, Input, Picker, ScrollView, Text, View } from "@tarojs/components";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  RoleSelectionRequiredError,
  StaleResponseError,
  TeacherApiClient,
  type SessionSnapshot,
  type WeeklyFeeSubmission
} from "@teaching-research-alliance/client";
import { taroTransport } from "../../services";
import { ReferralPanel } from "./referral-panel";
import "./index.css";

type Overview = Readonly<{
  nickname: string;
  balanceCents: string;
  currentYearIncomeByCategory: Readonly<Record<string, string>>;
}>;

type Fee = Readonly<{
  teachingWeekId: string;
  grossAmountCents: string;
  version: number;
  venueId: string;
}>;

type Referral = Readonly<{
  referralId: string;
  studentDisplayName: string;
  courseContextId: string;
  referralStatus: string;
  weeklyFees: readonly Fee[];
}>;

type Week = Readonly<{
  weekId: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  settlementMonth: string;
}>;

type Venue = Readonly<{
  id: string;
  name: string;
  isOwn: boolean;
}>;

const client = new TeacherApiClient({ transport: taroTransport });

const roleLabels: Readonly<Record<string, string>> = {
  TEACHING_TEACHER: "授课老师",
  ACADEMIC_PLANNER: "学业规划师",
  GROUP_LEADER: "教研组长",
  TEACHING_MENTOR: "指导导师",
  PLANNING_MENTOR: "学业规划导师",
  HEADQUARTERS_FINANCE: "总部财务",
  REGION_FINANCE: "分区财务",
  SYSTEM_ADMIN: "系统管理员",
  SYSTEM_OWNER: "开发者",
  CAMPUS_PRINCIPAL: "运营校长",
  VENUE_OWNER: "场地运营"
};

const incomeLabels: Readonly<Record<string, string>> = {
  teachingTeacher: "授课收入",
  referrer: "转介绍收入",
  planningMentor: "规划导师收入",
  groupLeader: "教研组长收入",
  teachingMentor: "指导导师收入",
  platformFinance: "平台财务收入",
  regionFinance: "分区财务收入"
};

const statusLabels: Readonly<Record<string, string>> = {
  PENDING: "待接收",
  ACCEPTED: "已接收",
  ARCHIVED: "已归档",
  REACTIVATED: "待重新接收"
};

const messages: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: "登录已失效，请重新登录。",
  VERSION_CONFLICT: "这笔费用已有新版本，请刷新后重新填写。",
  PERIOD_LOCKED: "该期间已关闭，暂时不能修改。",
  FORBIDDEN_SCOPE: "当前身份没有访问权限，请重新选择身份。",
  INVALID_INPUT: "请检查金额、教学周和场地后重试。",
  INTERNAL_ERROR: "暂时无法完成，请稍后重试。"
};

const isTeacher = (session: SessionSnapshot | null): boolean =>
  session?.currentRoleContext?.subject === "TEACHING_TEACHER";

export default function IndexPage(): ReactNode {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [referrals, setReferrals] = useState<readonly Referral[]>([]);
  const [weeks, setWeeks] = useState<readonly Week[]>([]);
  const [venues, setVenues] = useState<readonly Venue[]>([]);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [selectedReferralId, setSelectedReferralId] = useState("");
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [selectedVenueId, setSelectedVenueId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pendingSubmission = useRef<{ signature: string; submission: WeeklyFeeSubmission } | null>(null);

  const clearTeachingState = (): void => {
    setOverview(null);
    setReferrals([]);
    setWeeks([]);
    setVenues([]);
    setSelectedReferralId("");
    setSelectedWeekId("");
    setSelectedVenueId("");
    setAmount("");
    pendingSubmission.current = null;
  };

  const load = async (): Promise<void> => {
    const role = client.currentSession?.currentRoleContext?.subject;
    if (role !== "TEACHING_TEACHER" && role !== "ACADEMIC_PLANNER") return;
    const nextOverview = await client.getOwnOverview<Overview>();
    if (role === "TEACHING_TEACHER") {
      const [nextReferrals, nextWeeks, nextVenues] = await Promise.all([
        client.listReceivedReferrals<readonly Referral[]>(),
        client.listOpenTeachingWeeks<readonly Week[]>(),
        client.listAvailableVenues<readonly Venue[]>()
      ]);
      setReferrals(nextReferrals);
      setWeeks(nextWeeks);
      setVenues(nextVenues);
    }
    setOverview(nextOverview);
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      if (error instanceof StaleResponseError) return;
      if (error instanceof RoleSelectionRequiredError) {
        setNotice("当前身份需要重新选择。");
      } else if (error instanceof ApiClientError) {
        setNotice(messages[error.code] ?? "操作未完成，请检查当前身份后重试。");
        if (error.status === 409) {
          pendingSubmission.current = null;
          setSelectedReferralId("");
          try {
            await load();
          } catch {
            setNotice("已有新版本，但刷新失败。请点击刷新后重新填写。");
          }
        }
      } else if (error instanceof Error && error.message === "AMOUNT_REQUIRED") {
        setNotice("请填写非负金额，最多两位小数。");
      } else if (error instanceof Error && error.message === "ARCHIVED_NEW_FEE") {
        setNotice("已归档记录不能新增周费用，只能修改已有费用。");
      } else {
        setNotice("网络未确认结果。保持内容不变，再次保存可安全重试。");
      }
      if (!client.hasRoleContext) clearTeachingState();
    } finally {
      setSession(client.currentSession);
      setBusy(false);
    }
  };

  const chooseReferral = (referralId: string, weekId: string): void => {
    setSelectedReferralId(referralId);
    setSelectedWeekId(weekId);
    pendingSubmission.current = null;
    const existingFee = referrals
      .find((referral) => referral.referralId === referralId)
      ?.weeklyFees.find((fee) => fee.teachingWeekId === weekId);
    setAmount(existingFee === undefined ? "" : formatCentsAsBeans(existingFee.grossAmountCents));
    setSelectedVenueId(existingFee?.venueId ?? venues.find((venue) => venue.isOwn)?.id ?? "");
  };

  const saveWeeklyFee = async (): Promise<void> => {
    const week = weeks.find((item) => item.weekId === selectedWeekId);
    if (week === undefined || selectedReferralId === "" || selectedVenueId === "") {
      throw new Error("AMOUNT_REQUIRED");
    }
    const fee = referrals
      .find((referral) => referral.referralId === selectedReferralId)
      ?.weeklyFees.find((item) => item.teachingWeekId === selectedWeekId);
    const referral = referrals.find((item) => item.referralId === selectedReferralId);
    if (referral?.referralStatus === "ARCHIVED" && fee === undefined) {
      throw new Error("ARCHIVED_NEW_FEE");
    }
    let grossAmountCents: string;
    try {
      grossAmountCents = parseBeanAmountToCents(amount);
    } catch {
      throw new Error("AMOUNT_REQUIRED");
    }
    const draft = {
      referralCaseId: selectedReferralId,
      teachingWeekId: selectedWeekId,
      venueId: selectedVenueId,
      settlementMonth: week.settlementMonth,
      grossAmountCents,
      expectedVersion: fee?.version ?? 0
    };
    const signature = JSON.stringify(draft);
    if (pendingSubmission.current?.signature !== signature) {
      pendingSubmission.current = {
        signature,
        submission: client.createWeeklyFeeSubmission(draft)
      };
    }
    await client.recordWeeklyFee(pendingSubmission.current.submission);
    await load();
    pendingSubmission.current = null;
    setNotice("已保存，本周累计费用和个人余额已更新。");
  };

  const currentRoleIndex = session === null || session.currentRoleContext === null
    ? 0
    : Math.max(session.roleContexts.findIndex((role) => role.subject === session.currentRoleContext?.subject), 0);
  const roleChoices = session?.roleContexts.map((role) => roleLabels[role.subject] ?? role.subject) ?? [];
  const selectedReferral = referrals.find((referral) => referral.referralId === selectedReferralId);
  const selectableWeeks = selectedReferral?.referralStatus === "ARCHIVED"
    ? weeks.filter((week) => selectedReferral.weeklyFees.some((fee) => fee.teachingWeekId === week.weekId))
    : weeks;
  const incomeEntries = overview === null
    ? []
    : Object.entries(overview.currentYearIncomeByCategory).filter(([, value]) => BigInt(value) !== 0n);

  return (
    <ScrollView scrollY className="page-shell">
      <View className="page-header">
        <Text className="eyebrow">TEACHING ALLIANCE</Text>
        <Text className="page-title">{session === null ? "欢迎回来" : "我的教学"}</Text>
        {session !== null && (
          <Button
            className="quiet-button"
            disabled={busy}
            onClick={() => {
              void (async () => {
                if (busy) return;
                setBusy(true);
                let remoteEnded = true;
                try {
                  await client.endSession();
                } catch {
                  remoteEnded = false;
                } finally {
                  clearTeachingState();
                  setSession(null);
                  setNotice(remoteEnded ? "已退出当前账户。" : "本地已退出，但服务端注销未确认。");
                  setBusy(false);
                }
              })();
            }}
          >
            退出
          </Button>
        )}
      </View>

      {notice !== "" && <View className="notice"><Text>{notice}</Text></View>}

      {session === null ? (
        <View className="panel login-panel">
          <Text className="panel-title">登录你的账户</Text>
          <Text className="panel-description">使用手机号和密码进入个人工作台。</Text>
          <Text className="field-label">手机号</Text>
          <Input
            className="text-input"
            type="number"
            value={phone}
            placeholder="请输入手机号"
            onInput={(event) => setPhone(event.detail.value)}
          />
          <Text className="field-label">密码</Text>
          <Input
            className="text-input"
            password
            value={password}
            placeholder="请输入密码"
            onInput={(event) => setPassword(event.detail.value)}
          />
          <Button
            className="primary-button"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                await client.login({ phoneNormalized: phone, password });
                setPassword("");
                setSession(client.currentSession);
                if (client.hasRoleContext) await load();
              });
            }}
          >
            {busy ? "正在登录…" : "登录"}
          </Button>
        </View>
      ) : (
        <>
          <View className="panel role-panel">
            <View>
              <Text className="account-name">{overview?.nickname ?? "我的账户"}</Text>
              <Text className="role-hint">切换身份后，页面会按当前身份重新读取。</Text>
            </View>
            <Picker
              mode="selector"
              range={roleChoices}
              value={currentRoleIndex}
              disabled={busy || roleChoices.length === 0}
              onChange={(event) => {
                const role = session.roleContexts[Number(event.detail.value)];
                if (role === undefined) return;
                clearTeachingState();
                void run(async () => {
                  await client.switchRole(role.subject);
                  await load();
                });
              }}
            >
              <View className="picker-value">
                <Text>{session.currentRoleContext === null ? "请选择身份" : roleChoices[currentRoleIndex]}</Text>
                <Text>⌄</Text>
              </View>
            </Picker>
            <Button
              className="quiet-button"
              disabled={busy}
              onClick={() => {
                clearTeachingState();
                void run(async () => {
                  await client.refreshSession();
                  await load();
                });
              }}
            >
              刷新
            </Button>
          </View>

          {session.currentRoleContext === null && (
            <View className="panel"><Text>请选择已授权身份后查看工作台。</Text></View>
          )}

          {overview !== null && (
            <>
              <View className="balance-card">
                <Text className="balance-caption">个人可用余额 / 欢乐豆</Text>
                <Text className="balance-value">{formatCentsAsBeans(overview.balanceCents)}</Text>
                <Text className="balance-note">个人账户余额</Text>
              </View>
              <View className="panel income-panel">
                <Text className="panel-title">当前财年课时分润</Text>
                {incomeEntries.length === 0 ? (
                  <Text className="panel-description">暂无收入记录</Text>
                ) : incomeEntries.map(([category, value]) => (
                  <View className="income-row" key={category}>
                    <Text>{incomeLabels[category] ?? "其他课时收入"}</Text>
                    <Text>{formatCentsAsBeans(value)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {["TEACHING_TEACHER","ACADEMIC_PLANNER","PLANNING_MENTOR"].includes(session.currentRoleContext?.subject ?? "") && (
            <ReferralPanel key={`${session.personId}:${session.currentRoleContext?.subject}`} client={client} onSessionInvalidated={()=>{
              clearTeachingState();setSession(client.currentSession);setNotice("登录或身份已失效，请重新登录或选择身份。");
            }}/>
          )}
          {isTeacher(session) && (
            <>
              <View className="panel">
                <View className="section-heading">
                  <Text className="panel-title">我的生源库</Text>
                  <Text className="section-count">{referrals.length} 位学生</Text>
                </View>
                {referrals.length === 0 ? (
                  <Text className="panel-description">暂无学生记录</Text>
                ) : referrals.map((referral) => (
                  <View className="student-row" key={referral.referralId}>
                    <View className="student-detail">
                      <Text className="student-name">{referral.studentDisplayName}</Text>
                      <Text className="student-meta">
                        {referral.courseContextId} · {statusLabels[referral.referralStatus] ?? referral.referralStatus}
                      </Text>
                      {referral.referralStatus !== "ACCEPTED" && (
                        <Text className="student-meta">此页面暂不提供接收操作。</Text>
                      )}
                    </View>
                    {(() => {
                      const existingOpenFee = referral.weeklyFees.find((fee) =>
                        weeks.some((week) => week.weekId === fee.teachingWeekId)
                      );
                      const initialWeekId = referral.referralStatus === "ARCHIVED"
                        ? existingOpenFee?.teachingWeekId ?? ""
                        : weeks[0]?.weekId ?? "";
                      return (
                      <Button
                        className="quiet-button student-button"
                        disabled={busy || initialWeekId === ""}
                        onClick={() => chooseReferral(referral.referralId, initialWeekId)}
                      >
                        登记周费用
                      </Button>
                      );
                    })()}
                  </View>
                ))}
              </View>

              {selectedReferral !== undefined && (
                <View className="panel">
                  <Text className="panel-title">{selectedReferral.studentDisplayName} · 周累计费用</Text>
                  <Text className="panel-description">
                    填写本周所有课程的累计金额。保存后系统按新旧金额差额更新账户。
                  </Text>
                  <Text className="field-label">教学周</Text>
                  <Picker
                    mode="selector"
                    range={selectableWeeks.map((week) => `${week.startsOn} 至 ${week.endsOn}`)}
                    value={Math.max(selectableWeeks.findIndex((week) => week.weekId === selectedWeekId), 0)}
                    disabled={busy || selectableWeeks.length === 0}
                    onChange={(event) => {
                      const week = selectableWeeks[Number(event.detail.value)];
                      if (week !== undefined) chooseReferral(selectedReferralId, week.weekId);
                    }}
                  >
                    <View className="picker-value"><Text>{selectableWeeks.find((week) => week.weekId === selectedWeekId)?.startsOn ?? "请选择教学周"}</Text><Text>⌄</Text></View>
                  </Picker>
                  <Text className="field-label">授课场地</Text>
                  <Picker
                    mode="selector"
                    range={venues.map((venue) => `${venue.name}${venue.isOwn ? "（本人场地，免费）" : ""}`)}
                    value={Math.max(venues.findIndex((venue) => venue.id === selectedVenueId), 0)}
                    disabled={busy || venues.length === 0}
                    onChange={(event) => {
                      const venue = venues[Number(event.detail.value)];
                      if (venue !== undefined) setSelectedVenueId(venue.id);
                    }}
                  >
                    <View className="picker-value"><Text>{venues.find((venue) => venue.id === selectedVenueId)?.name ?? "请选择场地"}</Text><Text>⌄</Text></View>
                  </Picker>
                  <Text className="field-label">本周累计 / 欢乐豆</Text>
                  <Input
                    className="text-input"
                    type="digit"
                    value={amount}
                    placeholder="例如 1000.00"
                    disabled={busy}
                    onInput={(event) => setAmount(event.detail.value)}
                  />
                  <Button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => { void run(saveWeeklyFee); }}
                  >
                    {busy ? "正在保存…" : "保存周累计费用"}
                  </Button>
                </View>
              )}
            </>
          )}
        </>
      )}

      <View className="page-footer">
        <Text>本地开发预览 · 当前提供教师录费和个人概览，完整业务仍在开发。</Text>
      </View>
    </ScrollView>
  );
}
