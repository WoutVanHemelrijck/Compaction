import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, signup } from '../api/client';
import { useAuthStore } from '../stores/authStore';
import '../styles/auth.css';

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { login: storeLogin, token } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (token) void navigate('/collections', { replace: true });
  }, [token, navigate]);

  function switchMode(next: 'login' | 'signup') {
    setMode(next);
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const fn = mode === 'login' ? login : signup;
      const res = await fn(username.trim(), password);
      storeLogin(res.token, username.trim());
      void navigate('/collections', { replace: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="logo-mark">DB</span>
          <span className="logo-num">9</span>
        </div>
        <h1 className="auth-title">SimpleDBMS</h1>
        <p className="auth-subtitle">Team 09</p>

        <div className="auth-tabs">
          <button className={`auth-tab ${mode === 'login' ? 'active' : ''}`} onClick={() => switchMode('login')}>
            Log in
          </button>
          <button className={`auth-tab ${mode === 'signup' ? 'active' : ''}`} onClick={() => switchMode('signup')}>
            Sign up
          </button>
        </div>

        <form
          className="auth-form"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          <div className="form-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button className="btn btn-primary btn-full" type="submit" disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
