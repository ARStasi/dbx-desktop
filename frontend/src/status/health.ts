import type { Provider } from "../../bindings/dbx-desktop/internal/cloudstatus/models";

export type Watch = Record<string, string[]>;
export const providerNames: Record<string, string> = { aws: "AWS", azure: "Azure", gcp: "GCP" };
export const labels: Record<string, string> = {
  operational: "Operational", maintenance: "Maintenance", degraded: "Degraded",
  outage: "Service disruption", security: "Security event", unknown: "Status unavailable",
};
const severity: Record<string, number> = { operational: 0, maintenance: 1, unknown: 2, degraded: 3, outage: 4, security: 5 };

export function providerUnavailable(provider: Provider | undefined, now: number): boolean {
  return !provider || !!provider.error || !provider.fetchedAt || now - provider.fetchedAt > 10 * 60_000;
}

export function regionHealth(provider: Provider | undefined, id: string, now: number): string {
  if (providerUnavailable(provider, now)) return "unknown";
  const value = provider?.regions?.find((r) => r.id === id)?.health ?? "unknown";
  return value in severity ? value : "unknown";
}

export function watchSummary(providers: Provider[], watch: Watch, now: number) {
  const items = Object.entries(watch).flatMap(([providerID, ids]) => {
    const provider = providers.find((p) => p.id === providerID);
    return ids.map((id) => ({
      providerID, id, providerName: providerNames[providerID] ?? providerID,
      name: provider?.regions?.find((r) => r.id === id)?.name ?? (providerUnavailable(provider, now) ? "Region status unavailable" : "Region no longer listed"),
      health: regionHealth(provider, id, now),
    }));
  });
  const health = items.reduce((worst, item) => severity[item.health] > severity[worst] ? item.health : worst, "operational");
  const unavailable = items.filter((i) => i.health === "unknown").length;
  const affected = items.filter((i) => i.health !== "operational" && i.health !== "unknown").length;
  const text = !items.length ? "Choose cloud & regions"
    : health === "operational" ? "All watched regions operational"
    : [affected ? `${affected} ${affected === 1 ? "region needs" : "regions need"} attention` : "", unavailable ? `${unavailable} unavailable` : ""].filter(Boolean).join(" · ");
  return { items, health: items.length ? health : "unknown", text };
}
