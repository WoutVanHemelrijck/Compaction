import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserData, getAllUserData } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import '../styles/components.css';

interface UserData {
  userId: string;
  username: string;
  hashedPassword: string;
}

export default function AccountPage() {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);

  const { logout } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    getUserData()
      .then((d) => {
        setUserData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleExport() {
    setExportLoading(true);
    try {
      const data = await getAllUserData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${userData?.username ?? 'my'}-data.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // silently ignore export errors
    } finally {
      setExportLoading(false);
    }
  }

  function handleLogout() {
    logout();
    void navigate('/login', { replace: true });
  }

  return (
    <div className="account-page">
      <h2 className="page-title">Account</h2>

      {loading ? (
        <div className="list-placeholder">Loading…</div>
      ) : (
        <div className="account-card">
          <div className="account-field">
            <span className="account-label">User ID</span>
            <span className="account-value mono">{userData?.userId ?? '—'}</span>
          </div>
          <div className="account-field">
            <span className="account-label">Username</span>
            <span className="account-value">{userData?.username ?? '—'}</span>
          </div>
          <div className="account-field">
            <span className="account-label">Password hash</span>
            <span className="account-value mono truncate" title={userData?.hashedPassword}>
              {userData?.hashedPassword ?? '—'}
            </span>
          </div>
        </div>
      )}

      <div className="account-actions">
        <button className="btn btn-secondary" onClick={() => void handleExport()} disabled={exportLoading}>
          {exportLoading ? 'Exporting…' : 'Export all my data'}
        </button>
        <button className="btn btn-danger" onClick={handleLogout}>
          Log out
        </button>
      </div>
    </div>
  );
}
