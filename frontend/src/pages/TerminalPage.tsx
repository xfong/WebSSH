import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import VirtualKeyboard from '../components/keyboard/VirtualKeyboard';
import MouseButtons from '../components/keyboard/MouseButtons';
import ThemeToggle from '../components/common/ThemeToggle';
import AdminNotification from '../components/common/AdminNotification';

export default function TerminalPage() {
  const { nodeId } = useParams<{ nodeId: string }>();
  const { token, logout } = useAuth();
  const navigate = useNavigate();
  const termRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !nodeId || !termRef.current) return;

    const term = new Terminal({
      theme: { background: '#0d0d0d', foreground: '#f0f0f0' },
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      fontSize: 14,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const deviceId = sessionStorage.getItem('deviceId') || crypto.randomUUID();
    const socket = io('/ws/terminal', {
      transports: ['websocket', 'polling'],
      auth: { token, deviceId },
      query: { nodeId },
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('terminal_output', (data: string) => term.write(data));
    socket.on('error', (e: { message: string }) => setError(e.message));
    socket.on('force_close_tabs', () => { socket.disconnect(); window.close(); });
    socket.on('admin_notification', (d: { message: string }) => {
      setAdminMsg(d.message);
    });

    term.onData((data) => socket.emit('terminal_input', data));

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      socket.emit('terminal_resize', { cols: term.cols, rows: term.rows });
    });
    if (termRef.current) resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      socket.disconnect();
      term.dispose();
    };
  }, [token, nodeId, logout, navigate]);

  function sendToTerminal(data: string) {
    socketRef.current?.emit('terminal_input', data);
  }

  function handleClose() {
    if (confirm('Close this terminal session? All child windows will also be closed.')) {
      // Signal the control channel to close this node
      const deviceId = sessionStorage.getItem('deviceId') || '';
      const ctrlSocket = io('/ws/control', {
        transports: ['websocket', 'polling'],
        auth: { token, deviceId },
      });
      ctrlSocket.emit('close_node', { nodeId });
      ctrlSocket.once('disconnect', () => window.close());
      setTimeout(() => window.close(), 1000);
    }
  }

  return (
    <div style={styles.page}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>Terminal — {nodeId?.slice(0, 8)}</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <ThemeToggle compact />
          <button className="danger" onClick={handleClose}>Close</button>
        </div>
      </div>

      {adminMsg && (
        <AdminNotification
          message={adminMsg}
          onAcknowledge={() => { setAdminMsg(null); logout(); navigate('/login'); }}
        />
      )}
      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* Top panel: terminal */}
      <div style={styles.termPanel}>
        <div ref={termRef} style={{ width: '100%', height: '100%' }} />
        {!connected && !error && <div style={styles.connecting}>Connecting…</div>}
      </div>

      {/* Bottom panel: virtual keyboard + mouse buttons */}
      <div style={styles.bottomPanel}>
        <VirtualKeyboard onInput={sendToTerminal} />
        <MouseButtons termRef={termRef} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#0d0d0d' },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.5rem 1rem',
    background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)',
    position: 'sticky', top: 0, zIndex: 10,
  },
  toolbarTitle: { fontWeight: 600, fontSize: '0.9rem' },
  errorBanner: {
    background: 'var(--color-danger)', color: '#fff',
    padding: '0.5rem 1rem', fontSize: '0.9rem',
  },
  termPanel: {
    flex: '0 0 auto',
    minHeight: '60vh',
    position: 'relative',
    padding: '0.5rem',
    background: '#0d0d0d',
  },
  connecting: {
    position: 'absolute', inset: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    color: '#888', fontSize: '1rem',
  },
  bottomPanel: {
    display: 'flex', flexDirection: 'row', alignItems: 'flex-start',
    gap: '0.75rem',
    padding: '0.75rem',
    background: 'var(--color-surface)',
    borderTop: '1px solid var(--color-border)',
  },
};
