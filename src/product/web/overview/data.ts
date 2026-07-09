import { getFinancePortfolio } from "../../../capability/finance/data";
import { getHealthDashboard } from "../../../capability/health/data";
import { listIntegrations, type IntegrationCatalogEntry } from "../../../capability/integration/data";
import { getLifeSnapshot } from "../life/data";
import { readSnapshot } from "../../../core/snapshots/snapshots";

export type OverviewData = {
  health: {
    status: "connected" | "partial" | "disconnected";
    score: number | null;
    nudge: string;
    confidence: "low" | "medium" | "high";
    weekWorkoutCount: number;
  };
  life: {
    status: "connected" | "partial" | "disconnected";
    executionScore: number | null;
    doNow: string;
    doNext: string;
    currentEvent: { summary: string } | null;
    nextEvent: { summary: string; startsInMinutes: number } | null;
    todayEventCount: number;
  };
  finance: {
    status: "connected" | "partial" | "disconnected";
    equity: number | null;
    cash: number | null;
    dayChangePercent: number | null;
  };
  integrations: IntegrationCatalogEntry[];
  agentStatus: "online" | "idle" | "offline";
  agentCount: number;
  timezone: string;
};

export function getOverview(): OverviewData {
  return readSnapshot("overview_snapshot", "overview", buildOverview);
}

function buildOverview(): OverviewData {
  const health = getHealthDashboard();
  const life = getLifeSnapshot();
  const finance = getFinancePortfolio();
  const integrations = listIntegrations().integrations;
  return {
    health: {
      status: health.recentMeals.length || health.recentWorkouts.length || health.macroProfile ? "partial" : "disconnected",
      score: null,
      nudge: health.todayMeals.length ? "Meals logged today." : "Log a meal or sync Hevy to improve health context.",
      confidence: health.recentMeals.length || health.recentWorkouts.length ? "medium" : "low",
      weekWorkoutCount: health.recentWorkouts.length,
    },
    life: {
      status: life.todayEventCount || life.queue.length ? "partial" : "disconnected",
      executionScore: life.executionScore,
      doNow: life.doNow,
      doNext: life.doNext,
      currentEvent: life.currentEvent,
      nextEvent: life.nextEvent,
      todayEventCount: life.todayEventCount,
    },
    finance: {
      status: finance.portfolio ? "partial" : "disconnected",
      equity: finance.portfolio?.equity ?? null,
      cash: finance.portfolio?.cash ?? null,
      dayChangePercent: dayChangePercent(finance.history),
    },
    integrations,
    agentStatus: "online",
    agentCount: 1,
    timezone: life.timezoneLabel,
  };
}

function dayChangePercent(history: Array<{ equity: number }>): number | null {
  if (history.length < 2) return null;
  const previous = history[history.length - 2]?.equity;
  const current = history[history.length - 1]?.equity;
  if (!previous || current === undefined) return null;
  return ((current - previous) / previous) * 100;
}
