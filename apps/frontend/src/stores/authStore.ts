import { create } from 'zustand';

interface AuthState {
  token: string | null;
  username: string | null;
  login: (token: string, username: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('sessionToken'),
  username: localStorage.getItem('username'),

  login(token, username) {
    localStorage.setItem('sessionToken', token);
    localStorage.setItem('username', username);
    set({ token, username });
  },

  logout() {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('username');
    set({ token: null, username: null });
  },
}));
