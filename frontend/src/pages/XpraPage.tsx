import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import VirtualKeyboard from '../components/keyboard/VirtualKeyboard';
import MouseButtons from '../components/keyboard/MouseButtons';
import ThemeToggle from '../components/common/ThemeToggle';

export default function XpraPage() {
  const { nodeId } = useParams<{ nodeId: string }>();
  const { token, logout } = useAuth();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);
  const xpraContainerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token || !nodeId) return;
    const deviceId = sessionStorage.getItem('deviceId') || crypto.randomUUID();

    const socket = io('/ws/xpra', {
      transports: ['websocket', 'polling'],
      auth: { token, deviceId },
      query: { nodeId },
    });
    socketRef.current = socket;

    socket.on('xpra_ready', () => setStatus('ready'));
    socket.on('error', (e: { message: string }) => { setStatus('error'); setErrorMsg(e.message); });
    socket.on('xpra_closed', () => { setStatus('error'); setErrorMsg('Xpra session closed.'); });
    socket.on('force_close_tabs', () => { socket.disconnect(); window.close(); });
    socket.on('admin_notification', (d: { message: string }) => {
      alert(d.message);
      logout();
      navigate('/login');
    });

    return () => { socket.disconnect(); };
  }, [token, nodeId, logout, navigate]);

  function sendToXpra(data: string) {
    socketRef.current?.emit('xpra_data', data);
  }

  function handleClose() {
    if (confirm('Close this GUI window? All child windows will also be closed.')) {
      const deviceId = sessionStorage.getItem('deviceId') || '';
      const ctrlSocket = io('/ws/control', {
        transports: ['websocket', 'polling'],
        auth: { token, deviceId },
      });
      ctrlSocket.emit('close_node', { nodeId });
      setTimeout(() => window.close(), 1000);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>GUI Window — {nodeId?.slice(0, 8)}</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <ThemeToggle compact />
          <button className="danger" onClick={handleClose}>Close</button>
        </div>
      </div>

      {/* Top panel: Xpra HTML5 canvas */}
      <div style={styles.xpraPanel} ref={xpraContainerRef}>
        {status === 'connecting' && <div style={styles.overlay}>Connecting to Xpra session…</div>}
        {status === 'error' && <div style={{ ...styles.overlay, color: 'var(--color-danger)' }}>{errorMsg}</div>}
        {/* Xpra HTML5 client iframe — the actual Xpra HTML5 client is served by the Xpra daemon */}
        {status === 'ready' && (
          <iframe
            src={`/xpra-client/?nodeId=${nodeId}`}
            style={{ width: '100%', height: '100%', border: 'none' }}
            title="Xpra GUI"
          />
        )}
      </div>

      {/* Bottom panel: virtual keyboard + mouse buttons */}
      <div style={styles.bottomPanel}>
        <VirtualKeyboard onInput={sendToXpra} />
        <MouseButtons termRef={xpraContainerRef} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--color-bg)' },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.5rem 1rem',
    background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)',
    position: 'sticky', top: 0, zIndex: 10,
  },
  toolbarTitle: { fontWeight: 600, fontSize: '0.9rem' },
  xpraPanel: {
    flex: '0 0 auto', minHeight: '60vh', position: 'relative',
    background: '#1a1a1a',
  },
  overlay: {
    position: 'absolute', inset: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    color: '#888', fontSize: '1rem',
  },
  bottomPanel: {
    display: 'flex', flexDirection: 'row', alignItems: 'flex-start',
    gap: '0.75rem', padding: '0.75rem',
    background: 'var(--color-surface)', borderTop: '1px solid var(--color-border)',
  },
};
