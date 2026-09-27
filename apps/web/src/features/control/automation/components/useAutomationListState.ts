import { useEffect, useState } from "react";
import type { AutomationListQuery } from "../../../../api/automation";
import type { AutomationListFilter } from "./AutomationRuleControls";

export const defaultAutomationListFilter: AutomationListFilter = {
  query: "", status: "all", syncStatus: "all", limit: 10
};

interface ListState {
  scopeKey: string;
  filter: AutomationListFilter;
  appliedQuery: string;
  pageIndex: number;
}

function initialState(scopeKey: string): ListState {
  return { scopeKey, filter: defaultAutomationListFilter, appliedQuery: "", pageIndex: 0 };
}

export function useAutomationListState(scopeKey: string) {
  const [stored, setStored] = useState(() => initialState(scopeKey));
  const state = stored.scopeKey === scopeKey ? stored : initialState(scopeKey);

  useEffect(() => {
    if (stored.scopeKey !== scopeKey) setStored(initialState(scopeKey));
  }, [scopeKey, stored.scopeKey]);

  useEffect(() => {
    const trimmed = state.filter.query.trim();
    if (trimmed === state.appliedQuery) return;
    const timer = window.setTimeout(() => setStored((current) => current.scopeKey === scopeKey
      ? { ...current, appliedQuery: current.filter.query.trim() } : current), 300);
    return () => window.clearTimeout(timer);
  }, [scopeKey, state.appliedQuery, state.filter.query]);

  function changeFilter(filter: AutomationListFilter) {
    setStored((current) => ({ ...current, scopeKey, filter, pageIndex: 0 }));
  }

  function changePage(pageIndex: number) {
    setStored((current) => current.scopeKey === scopeKey ? { ...current, pageIndex: Math.max(0, pageIndex) } : current);
  }

  return {
    filter: state.filter,
    appliedQuery: state.appliedQuery,
    pageIndex: state.pageIndex,
    isSearchPending: state.filter.query.trim() !== state.appliedQuery,
    changeFilter,
    changePage
  };
}

export function automationListRequest(filter: AutomationListFilter, appliedQuery: string): AutomationListQuery {
  return {
    limit: filter.limit,
    ...(appliedQuery ? { query: appliedQuery } : {}),
    ...(filter.status !== "all" ? { status: filter.status } : {}),
    ...(filter.syncStatus !== "all" ? { syncStatus: filter.syncStatus } : {})
  };
}
