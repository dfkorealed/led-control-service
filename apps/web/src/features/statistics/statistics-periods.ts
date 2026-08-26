export function getEnergySeriesRanges(generatedAt: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date(generatedAt));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const yearText = String(year).padStart(4, "0");
  const monthText = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    day: { from: `${yearText}-${monthText}-01`, to: `${yearText}-${monthText}-${String(lastDay).padStart(2, "0")}` },
    month: { from: `${yearText}-01-01`, to: `${yearText}-12-01` }
  };
}
