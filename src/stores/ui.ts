import { create } from "zustand";

export type PageId = "home" | "history" | "settings";

interface UiState {
  page: PageId;
  setPage: (page: PageId) => void;
}

/** top-tab navigation only (D12) — no sidebar, ever. */
export const useUi = create<UiState>((set) => ({
  page: "home",
  setPage: (page) => set({ page }),
}));
