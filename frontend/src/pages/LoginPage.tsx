import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login, token } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hostname, setHostname] = useState('');

  useEffect(() => {
    if (token) navigate('/', { replace: true });
    fetch('/api/v1/config')
      .then((r) => r.json())
      .then((d) => setHostname(d.hostname || ''))
      .catch(() => {});
  }, [token, navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Login failed');
        return;
      }
      const data = await res.json();
      login(data.token, data.username, data.role);
      navigate('/', { replace: true });
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>WebSSH</h1>
        {hostname && <p style={styles.subtitle}>{hostname}</p>}
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              style={{ marginTop: '0.3rem' }}
            />
          </label>
          <label style={styles.label}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={{ marginTop: '0.3rem' }}
            />
          </label>
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" disabled={loading} style={{ width: '100%', marginTop: '0.5rem' }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-bg)',
    padding: '1rem',
  },
  card: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '10px',
    padding: '2rem',
    width: '100%',
    maxWidth: '380px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
  },
  title: { fontSize: '1.6rem', fontWeight: 700, marginBottom: '0.2rem' },
  subtitle: { color: 'var(--color-text-muted)', marginBottom: '1.2rem', fontSize: '0.9rem' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  label: { display: 'flex', flexDirection: 'column', fontWeight: 500 },
  error: { color: 'var(--color-danger)', fontSize: '0.88rem' },
};
