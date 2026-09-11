export function formatKwh(value: number) {
  return `${formatKwhValue(value)} kWh`;
}

export function formatKwhValue(value: number) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(value);
}

export function formatWon(value: number) {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value)}원`;
}

export function formatPercent(value: number, maximumFractionDigits = 2) {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits }).format(value)}%`;
}

export function formatCoverage(value: number | null) {
  return value === null ? "산정 불가" : formatPercent(value * 100, 0);
}

export function formatComparisonPeriod(period: string) {
  const [year, month, day] = period.split("-").map(Number);
  return day ? `${year}년 ${month}월 ${day}일` : `${year}년 ${month}월`;
}
