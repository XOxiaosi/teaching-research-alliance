import {
  RiAdminLine,
  RiBankCardLine,
  RiBarChartBoxLine,
  RiBuilding2Line,
  RiCheckboxCircleLine,
  RiDashboardLine,
  RiExchangeFundsLine,
  RiExchangeLine,
  RiFileHistoryLine,
  RiGiftLine,
  RiHistoryLine,
  RiMoneyCnyBoxLine,
  RiReceiptLine,
  RiRefund2Line,
  RiRefundLine,
  RiSafe2Line,
  RiShareForwardLine,
  RiShieldCheckLine,
  RiShoppingBag3Line,
  RiWallet3Line,
  type RemixiconComponentType,
} from "@remixicon/react";

export type DashboardIconName =
  | "fees"
  | "overview"
  | "referrals"
  | "withdrawals"
  | "venue-board"
  | "organization-revenue"
  | "group-leader-change"
  | "salary"
  | "salary-confirmation"
  | "bonus-projects"
  | "benefits"
  | "finance"
  | "purchase"
  | "funds"
  | "accounts"
  | "purchase-history"
  | "reimbursements"
  | "reimbursement-history"
  | "refunds"
  | "refund-history";

const ICONS: Record<DashboardIconName, RemixiconComponentType> = {
  fees: RiMoneyCnyBoxLine,
  overview: RiDashboardLine,
  referrals: RiShareForwardLine,
  withdrawals: RiBankCardLine,
  "venue-board": RiBuilding2Line,
  "organization-revenue": RiBarChartBoxLine,
  "group-leader-change": RiExchangeLine,
  salary: RiWallet3Line,
  "salary-confirmation": RiCheckboxCircleLine,
  "bonus-projects": RiGiftLine,
  benefits: RiShieldCheckLine,
  finance: RiExchangeFundsLine,
  purchase: RiShoppingBag3Line,
  funds: RiSafe2Line,
  accounts: RiAdminLine,
  "purchase-history": RiHistoryLine,
  reimbursements: RiReceiptLine,
  "reimbursement-history": RiFileHistoryLine,
  refunds: RiRefund2Line,
  "refund-history": RiRefundLine,
};

export interface DashboardIconProps {
  name: DashboardIconName;
  className?: string;
}

export function DashboardIcon({ name, className }: DashboardIconProps) {
  const Icon = ICONS[name];
  const classes = ["nav-icon", className].filter(Boolean).join(" ");

  return <Icon aria-hidden="true" focusable="false" className={classes} />;
}
