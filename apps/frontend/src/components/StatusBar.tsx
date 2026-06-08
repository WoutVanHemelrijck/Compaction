import { useAuthStore } from '../stores/authStore';
import { useLocation } from 'react-router-dom';

export default function StatusBar() {
  const username = useAuthStore((s) => s.username);
  const location = useLocation();

  const match = location.pathname.match(/^\/collections\/([^/]+)/);
  const activeCollection = match ? decodeURIComponent(match[1]) : null;

  return (
    <div className="status-bar">
      <span>SimpleDBMS Team 09</span>
      {activeCollection && <span className="status-collection">{activeCollection}</span>}
      <div className="status-right">
        <span>{username}</span>
      </div>
    </div>
  );
}
