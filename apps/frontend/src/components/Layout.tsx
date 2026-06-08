import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import StatusBar from './StatusBar';
import '../styles/layout.css';

export default function Layout() {
  return (
    <div className="app-shell">
      <div className="app-body">
        <Sidebar />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
