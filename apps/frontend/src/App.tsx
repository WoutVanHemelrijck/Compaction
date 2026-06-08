import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AuthPage from './pages/AuthPage';
import DocumentsPage from './pages/DocumentsPage';
import AccountPage from './pages/AccountPage';
import NlpSearchPage from './pages/NlpSearchPage';
import RagPage from './pages/RagPage';
import SqlQueryPage from './pages/SqlQueryPage';
import NaturalLanguageQueryPage from './pages/NaturalLanguageQueryPage';
import Layout from './components/Layout';
import { useAuthStore } from './stores/authStore';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function WelcomeState() {
  return (
    <div className="welcome-state">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
        <rect x="4" y="8" width="32" height="6" rx="3" fill="#e2e8f0" />
        <rect x="4" y="18" width="32" height="6" rx="3" fill="#e2e8f0" opacity="0.6" />
        <rect x="4" y="28" width="32" height="6" rx="3" fill="#e2e8f0" opacity="0.3" />
      </svg>
      <p>Select a collection from the sidebar to get started</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<AuthPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/collections" replace />} />
          <Route path="collections" element={<WelcomeState />} />
          <Route path="collections/:name" element={<DocumentsPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="query/sql" element={<SqlQueryPage />} />
          <Route path="query/natural-language" element={<NaturalLanguageQueryPage />} />
          <Route path="search" element={<NlpSearchPage />} />
          <Route path="rag" element={<RagPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
