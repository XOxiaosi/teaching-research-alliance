import { useEffect, useState, type ReactNode } from "react";
import {
  ApiClientError,
  formatCentsAsBeans,
  parseBeanAmountToCents,
  StaleResponseError,
  type TeacherApiClient,
  type WeeklyFeeSubmission
} from "@teaching-research-alliance/client";

import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";

export type FeeReferral = Readonly<{
  referralId: string;
  studentDisplayName: string;
  courseContextId: string;
  referralStatus: string;
  initialVenueId?: string | null;
  weeklyFees: readonly Readonly<{
    refundStatus?: "ACTIVE" | "REFUNDED";
    teachingWeekId: string;
    grossAmountCents: string;
    version: number;
    venueId: string;
  }>[];
}>;

export type FeeWeek = Readonly<{
  weekId: string;
  periodLabel: string;
  startsOn: string;
  endsOn: string;
  settlementMonth: string;
}>;

export type FeeVenue = Readonly<{ id: string; name: string; isOwn: boolean }>;

type Props = Readonly<{
  client: TeacherApiClient;
  referrals: readonly FeeReferral[];
  weeks: readonly FeeWeek[];
  venues: readonly FeeVenue[];
  busy: boolean;
  loaded: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  reload: () => Promise<void>;
  onUnconfirmedChange: (value: boolean) => void;
  onDataMayChange: () => void;
}>;

type Field = "week" | "referral" | "venue" | "amount";
type FieldErrors = Partial<Record<Field, string>>;

const errorMessages: Readonly<Record<string, string>> = {
  WEEKLY_FEE_REFUNDED: "这笔周费用已退款，保留原登记金额供核对，不能再修改。",
  PERIOD_LOCKED: "该期间已关闭，请重新读取可录入期间。需要补录时请联系系统管理员。",
  PERIOD_MONTH_MISMATCH: "期间信息已发生变化，请刷新后重新选择。",
  VENUE_NOT_ACTIVE: "所选场地已不可用，请选择其他正常使用的场地。",
  REFERRAL_ARCHIVED: "该记录已归档，不能新增费用；已有费用可以更正。",
  REFERRAL_STATE_CONFLICT: "该学生课程已完结，不能新增费用；已有费用可以更正。",
  REFERRAL_NOT_FOUND: "这条学生记录已不可用，请刷新后重新选择。",
  TEACHING_WEEK_NOT_FOUND: "所选期间已不可用，请刷新后重新选择。",
  INVALID_INPUT: "填写内容未通过校验，请检查金额、期间和场地。",
  IDEMPOTENCY_REPLAY: "这次请求的核对信息不一致，未能确认保存，请刷新后重新核对。"
};

const isAuthOrStale = (error: unknown): boolean => error instanceof StaleResponseError
  || (error instanceof ApiClientError && (error.status === 401 || error.status === 403));

/** A server-backed fee form: an uncertain request stays immutable until it is confirmed. */
export function WeeklyFeePanel({ client, referrals, weeks, venues, busy, loaded, run, reload, onUnconfirmedChange, onDataMayChange }: Props): ReactNode {
  const [weekId, setWeekId] = useState("");
  const [referralId, setReferralId] = useState("");
  const [venueId, setVenueId] = useState("");
  const [amount, setAmount] = useState("");
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState("");
  const [receiptDetails, setReceiptDetails] = useState<{ version: number; runId: string } | null>(null);
  const [uncertainSubmission, setUncertainSubmission] = useState<WeeklyFeeSubmission | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);

  useEffect(() => {
    if (uncertainSubmission === null) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uncertainSubmission]);

  const week = weeks.find((item) => item.weekId === weekId);
  const referral = referrals.find((item) => item.referralId === referralId);
  const previous = referral?.weeklyFees.find((item) => item.teachingWeekId === weekId);
  const refunded = previous?.refundStatus === "REFUNDED";
  const relevant = referrals.filter((item) => (item.referralStatus !== "ARCHIVED" && item.referralStatus !== "COMPLETED")
    || item.weeklyFees.some((fee) => fee.teachingWeekId === weekId));
  const recorded = week === undefined ? [] : relevant.flatMap((item) => item.weeklyFees.filter((fee) => fee.teachingWeekId === weekId));
  const total = recorded.reduce((sum, fee) => sum + BigInt(fee.grossAmountCents), 0n);
  const locked = busy || uncertainSubmission !== null || refreshRequired;
  const hasInputs = referrals.length > 0 && weeks.length > 0;

  const clearFeedback = (): void => { setErrors({}); setNotice(""); setReceipt(""); setReceiptDetails(null); };

  const selectRecord = (nextReferralId: string, nextWeekId: string): void => {
    setReferralId(nextReferralId);
    setWeekId(nextWeekId);
    const nextReferral = referrals.find((item) => item.referralId === nextReferralId);
    const fee = nextReferral?.weeklyFees.find((item) => item.teachingWeekId === nextWeekId);
    setExpectedVersion(fee?.version ?? 0);
    const candidate = fee?.venueId ?? nextReferral?.initialVenueId ?? "";
    setVenueId(fee !== undefined ? candidate : (venues.some((item) => item.id === candidate) ? candidate : ""));
    setAmount(fee === undefined ? "" : formatCentsAsBeans(fee.grossAmountCents));
    clearFeedback();
  };

  const refresh = async (successMessage: string): Promise<void> => {
    setRefreshRequired(true);
    try {
      await reload();
      setRefreshRequired(false);
      setReferralId("");
      setVenueId("");
      setAmount("");
      setErrors({});
      setNotice(successMessage);
    } catch (error) {
      if (isAuthOrStale(error)) throw error;
      setNotice("刷新尚未完成，暂时不能继续录入。请点击“重新读取最新数据”。");
    }
  };

  const submit = async (submission: WeeklyFeeSubmission): Promise<void> => {
    setNotice("");
    setErrors({});
    try {
      const result = await client.recordWeeklyFee<Readonly<{ status: string; replay: boolean; fee: { version: number }; runId: string }>>(submission);
      onDataMayChange();
      setReceiptDetails({version:result.fee.version, runId:result.runId});
      setUncertainSubmission(null);
      onUnconfirmedChange(false);
      setReceipt(result.status === "NO_BALANCE_CHANGE"
        ? "服务器已确认保存，本次结算无余额变化。"
        : result.status === "POSTED"
          ? "服务器已确认保存，费用结算已完成。"
          : "服务器已接收费用，结算状态仍需确认。");
      await refresh("已读取最新数据，可选择下一条学生课程继续录入。");
    } catch (error) {
      if (isAuthOrStale(error)) throw error;
      if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
        setUncertainSubmission(null);
        onUnconfirmedChange(false);
        if (error.code === "VERSION_CONFLICT" || error.code === "WEEKLY_FEE_REFUNDED") {
          setReceipt("");
          setReceiptDetails(null);
          setNotice("该费用已被其他操作更新。正在读取最新值，请重新选择学生课程后核对再保存。");
          await refresh(error.code === "WEEKLY_FEE_REFUNDED" ? "这笔周费用已退款，不能再修改。已读取最新状态，可重新选择记录查看。" : "已读取最新费用。请重新选择学生课程，核对服务器金额后再修改。");
          return;
        }
        const explanation = errorMessages[error.code] ?? "服务器未接受本次保存，请核对资料后重试。";
        setNotice(explanation);
        if (error.code === "VENUE_NOT_ACTIVE") setErrors({ venue: explanation });
        if (error.code === "REFERRAL_ARCHIVED" || error.code === "REFERRAL_STATE_CONFLICT" || error.code === "REFERRAL_NOT_FOUND") setErrors({ referral: explanation });
        if (error.code === "PERIOD_LOCKED" || error.code === "PERIOD_MONTH_MISMATCH" || error.code === "TEACHING_WEEK_NOT_FOUND") {
          setErrors({ week: explanation });
          setRefreshRequired(true);
        }
        return;
      }
      onDataMayChange();
      setUncertainSubmission(submission);
      onUnconfirmedChange(true);
      setNotice("网络未能确认保存结果，填写内容已保留并锁定。请安全重试同一次保存，系统不会重复记账。");
    }
  };

  const save = async (): Promise<void> => {
    if (refunded) { setNotice(errorMessages.WEEKLY_FEE_REFUNDED ?? "这笔周费用已退款，不能再修改。"); return; }
    const nextErrors: FieldErrors = {};
    if (week === undefined) nextErrors.week = "请选择要录入的教学期间。";
    if (referral === undefined) nextErrors.referral = "请选择学生及对应课程。";
    else if ((referral.referralStatus === "ARCHIVED" || referral.referralStatus === "COMPLETED") && previous === undefined) nextErrors.referral = referral.referralStatus === "COMPLETED" ? "该学生课程已完结，不能新增费用。" : "该记录已归档，不能新增费用。";
    const historicalVenueAllowed = previous !== undefined && previous.venueId === venueId;
    if (!venues.some((item) => item.id === venueId) && !historicalVenueAllowed) nextErrors.venue = "请选择正常使用中的实际授课场地。";
    let cents = "";
    try { cents = parseBeanAmountToCents(amount); }
    catch { nextErrors.amount = amount === "" ? "请填写本期间累计金额；没有费用可明确填写 0。" : "请输入非负金额，最多保留两位小数。"; }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || week === undefined || referral === undefined) {
      setNotice("尚未提交，请检查标出的填写项。");
      return;
    }
    const submission = client.createWeeklyFeeSubmission({
      referralCaseId: referral.referralId, teachingWeekId: week.weekId, venueId,
      settlementMonth: week.settlementMonth, grossAmountCents: cents, expectedVersion
    });
    await submit(submission);
  };

  const fieldError = (field: Field): ReactNode => errors[field] === undefined ? null
    : <small className="fee-field-error" id={`fee-${field}-error`}>{errors[field]}</small>;

  return <Card className="fee-panel panel" role="region" aria-labelledby="weekly-fee-title">
    <div className="fee-heading"><div><span className="fee-eyebrow">教学记录</span><h2 id="weekly-fee-title">填写累计费用</h2></div><span className="fee-unit">单位：欢乐豆</span></div>
    <p className="fee-description">填写所选期间的累计费用，保存后自动结算，无需财务确认。</p>
    {!loaded && <p className="fee-empty" role="status">{busy ? "正在读取教学期间、学生和场地…" : "录费资料尚未读取成功，请点击页面上方的刷新后重试。"}</p>}
    {loaded && weeks.length === 0 && <p className="fee-empty">暂无开放的教学期间。需要补录时，请联系系统管理员开放原期间。</p>}
    {loaded && referrals.length === 0 && <p className="fee-empty">暂无分配给你的学生课程记录，收到推荐后可在这里录入费用。</p>}
    {loaded && venues.length === 0 && <p className="fee-empty">暂无正常使用中的场地，请先完成场地资料维护。</p>}
    {loaded && hasInputs && <form className="fee-form" noValidate onSubmit={(event) => { event.preventDefault(); if (!locked && !refunded) void run(save); }}>
      <div className="fee-fields">
        <div className="fee-field"><label htmlFor="fee-week">教学期间</label><select id="fee-week" disabled={locked} value={weekId} aria-invalid={errors.week !== undefined} aria-describedby={errors.week === undefined ? undefined : "fee-week-error"} onChange={(event) => selectRecord("", event.target.value)}>
          <option value="">请选择教学期间</option>{weeks.map((item) => <option key={item.weekId} value={item.weekId}>{item.periodLabel} · {item.startsOn} 至 {item.endsOn}</option>)}
        </select>{fieldError("week")}</div>
        <div className="fee-field"><label htmlFor="fee-referral">学生及课程</label><select id="fee-referral" disabled={locked || week === undefined} value={referralId} aria-invalid={errors.referral !== undefined} aria-describedby={errors.referral === undefined ? undefined : "fee-referral-error"} onChange={(event) => selectRecord(event.target.value, weekId)}>
          <option value="">请选择学生及课程</option>{relevant.map((item, index) => <option key={item.referralId} value={item.referralId}>{item.studentDisplayName} · {item.courseContextId} · 记录 {index + 1}{item.referralStatus === "ARCHIVED" ? "（已归档，仅更正）" : item.referralStatus === "COMPLETED" ? "（已完结，仅更正）" : ""}</option>)}
        </select>{fieldError("referral")}</div>
      </div>
      {week !== undefined && <>
        <p className="fee-period-note">所选期间：{week.startsOn} 至 {week.endsOn} · 结算月份：{week.settlementMonth.slice(0, 7)}</p>
        <dl className="fee-metrics"><div><dt>已录记录</dt><dd>{recorded.length}</dd></div><div><dt>待录记录</dt><dd>{Math.max(0, relevant.length - recorded.length)}</dd></div><div><dt>原登记累计 / 欢乐豆</dt><dd>{formatCentsAsBeans(total.toString())}</dd></div></dl>
        {recorded.some((fee) => fee.refundStatus === "REFUNDED") && <p className="fee-period-note">原登记累计包含已退款记录的历史金额。</p>}
      </>}
      <div className="fee-fields">
        <div className="fee-field"><label htmlFor="fee-venue">实际授课场地</label><select id="fee-venue" disabled={locked || refunded || referral === undefined} value={venueId} aria-invalid={errors.venue !== undefined} aria-describedby={errors.venue === undefined ? undefined : "fee-venue-error"} onChange={(event) => { setVenueId(event.target.value); clearFeedback(); }}>
          <option value="">请选择实际授课场地</option>{venues.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isOwn ? "（自有场地，场地费为 0）" : ""}</option>)}{previous !== undefined && !venues.some((item) => item.id === previous.venueId) && <option value={previous.venueId}>原登记场地（仅更正本笔）</option>}
        </select>{fieldError("venue")}</div>
        <div className="fee-field"><label htmlFor="fee-amount">本期间累计金额</label><input id="fee-amount" disabled={locked || refunded || referral === undefined} value={amount} inputMode="decimal" placeholder="例如 1500.00" aria-invalid={errors.amount !== undefined} aria-describedby={errors.amount === undefined ? "fee-amount-help" : "fee-amount-error"} onChange={(event) => { setAmount(event.target.value); clearFeedback(); }} />{fieldError("amount")}</div>
      </div>
      {refunded && <p className="fee-notice" role="status">这笔周费用已退款，保留原登记金额供核对，不能再修改。</p>}
      <p id="fee-amount-help" className="fee-amount-help">填写这条学生课程记录的期间累计金额，金额为 0 时请明确填 0；空白不会保存。</p>
      {referral !== undefined && <div className="fee-comparison"><span>已登记累计：<strong>{previous === undefined ? "尚未填写" : `${formatCentsAsBeans(previous.grossAmountCents)} 欢乐豆`}</strong></span><span>本次填写：<strong>{amount === "" ? "尚未填写" : `${amount} 欢乐豆`}</strong></span></div>}
      <div className="fee-actions"><Button type="submit" disabled={locked || refunded || week === undefined || referral === undefined}>{refunded ? "已退款，不可修改" : busy ? "正在处理…" : previous === undefined ? "保存累计费用" : "更新累计费用"}</Button><small>更正已有累计值后，系统按新旧结果的差额更新账户。</small></div>
    </form>}
    <div className="fee-feedback" aria-live="polite" aria-atomic="true">{receipt !== "" && <p className="fee-receipt">{receipt}</p>}{notice !== "" && <p className="fee-notice">{notice}</p>}</div>
    {receiptDetails !== null && <details className="fee-receipt-details"><summary>查看保存凭证 · 费用版本 {receiptDetails.version}</summary><p>本次结算记录：{receiptDetails.runId}</p></details>}
    {uncertainSubmission !== null && <Button className="fee-retry" disabled={busy} onClick={() => void run(() => submit(uncertainSubmission))}>安全重试这次保存</Button>}
    {refreshRequired && uncertainSubmission === null && <Button className="fee-refresh" disabled={busy} onClick={() => void run(() => refresh("已读取最新数据，请重新选择学生课程后核对。"))}>重新读取最新数据</Button>}
  </Card>;
}
