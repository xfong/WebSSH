import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import SessionTreePage from './pages/SessionTreePage';
import TerminalPage from './pages/TerminalPage';
import XpraPage from './pages/XpraPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <SessionTreePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/terminal/:nodeId"
        element={
          <ProtectedRoute>
            <TerminalPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/xpra/:nodeId"
        element={
          <ProtectedRoute>
            <XpraPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
