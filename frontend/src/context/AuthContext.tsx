import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type Role = 'user' | 'admin';
export type Theme = 'light' | 'dark' | 'system';

interface AuthState {
  token: string | null;
  username: string | null;
  role: Role | null;
}

interface AuthContextValue extends AuthState {
  login: (token: string, username: string, role: Role) => void;
  logout: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>(() => {
    const token = sessionStorage.getItem('token');
    const username = sessionStorage.getItem('username');
    const role = sessionStorage.getItem('role') as Role | null;
    return { token, username, role };
  });

  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem('theme') as Theme) || 'system';
  });

  // Apply theme to document root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  function login(token: string, username: string, role: Role) {
    sessionStorage.setItem('token', token);
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('role', role);
    setAuth({ token, username, role });
  }

  function logout() {
    // Invalidate the JWT on the server before clearing local state
    const currentToken = sessionStorage.getItem('token');
    if (currentToken) {
      fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${currentToken}` },
      }).catch(() => { /* best-effort; proceed with local logout regardless */ });
    }
    sessionStorage.clear();
    setAuth({ token: null, username: null, role: null });
  }

  function setTheme(t: Theme) {
    setThemeState(t);
  }

  return (
    <AuthContext.Provider value={{ ...auth, login, logout, theme, setTheme }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
