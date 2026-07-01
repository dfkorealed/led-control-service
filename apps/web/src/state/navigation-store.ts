import { create } from "zustand";

export type PrimaryView = "monitoring" | "control" | "statistics" | "settings";

interface NavigationState {
  view: PrimaryView;
  setView: (view: PrimaryView) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  view: "monitoring",
  setView: (view) => set({ view })
}));
