import { create } from 'zustand';

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export const useConnectionStore = create<{
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
}>((set) => ({
  status: 'connecting',
  setStatus: (status) => set({ status }),
}));
