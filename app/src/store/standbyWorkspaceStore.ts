import { create } from 'zustand';
import type { ScriptProjection } from '@/types/script';
import type { WorkspaceSnapshot } from '@/types/standby';

type StandbyWorkspaceStore = {
  caseId: string | null;
  workspace: WorkspaceSnapshot | null;
  scriptProjection: ScriptProjection | null;
  setWorkspace: (caseId: string, workspace: WorkspaceSnapshot) => void;
  setScriptProjection: (scriptProjection: ScriptProjection | null) => void;
  clear: () => void;
};

export const useStandbyWorkspaceStore = create<StandbyWorkspaceStore>((set) => ({
  caseId: null,
  workspace: null,
  scriptProjection: null,
  setWorkspace: (caseId, workspace) => set({ caseId, workspace }),
  setScriptProjection: (scriptProjection) => set({ scriptProjection }),
  clear: () => set({ caseId: null, workspace: null, scriptProjection: null }),
}));
