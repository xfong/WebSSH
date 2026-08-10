/**
 * XpraPage.tsx
 *
 * Renders a GUI window tab. The Xpra HTML5 client is embedded in an iframe
 * that connects directly to the Xpra HTML5 server via the backend WebSocket
 * proxy (/ws/xpra). The control socket monitors for admin notifications and
 * force-close signals.
 *
 * Layout (two-panel, scrollable):
 *   Top panel  — Xpra HTML5 iframe (full GUI rendering)
 *   Bottom panel — virtual keyboard + mouse buttons
 */

import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import VirtualKeyboard from '../components/keyboard/VirtualKeyboard';
import MouseButtons from '../components/keyboard/MouseButtons';
import ThemeToggle from '../components/common/ThemeToggle';
import AdminNotification from '../components/common/AdminNotification';

export default function XpraPage() {
  const { nodeId } = useParams<{ nodeId: string }>();
  const { token, logout } = useAuth();
  const navigate = useNavigate();
  const controlSocketRef = useRef<Socket | null>(null);
  const xpraContainerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState<string>('GUI Window');

  useEffect(() => {
    if (!token || !nodeId) return;
    const deviceId = sessionStorage.getItem('deviceId') || crypto.randomUUID();
    sessionStorage.setItem('deviceId', deviceId);

    // ── Control socket: listens for admin_notification and force_close_tabs ──
    const ctrl = io('/ws/control', {
      transports: ['websocket', 'polling'],
      auth: { token, deviceId },
    });
    controlSocketRef.current = ctrl;

    ctrl.on('connect', () => {
      // Join the node room so we receive targeted close signals
      ctrl.emit('join_node', { nodeId });
    });

    ctrl.on('admin_notification', (d: { message: string }) => {
      setAdminMsg(d.message);
    });

    ctrl.on('force_close_tabs', (d: { nodeId?: string; deviceId?: string }) => {
      if (d.nodeId === nodeId || d.deviceId === deviceId) {
        ctrl.disconnect();
        window.close();
      }
    });

    // ── Fetch node name from the tree for the toolbar title ──────────────────
    ctrl.on('tree_update', (d: { tree: unknown[] }) => {
      const name = _findNodeName(d.tree, nodeId);
      if (name) setNodeName(name);
    });

    // ── Verify the Xpra session is reachable via the backend proxy ───────────
    // We use a lightweight Socket.IO connection to /ws/xpra just to confirm
    // the session is live. The actual GUI rendering is done by the iframe below.
    const xpraSocket = io('/ws/xpra', {
      transports: ['websocket', 'polling'],
      auth: { token, deviceId },
      query: { nodeId },
    });

    xpraSocket.on('xpra_ready', () => {
      setStatus('ready');
      // Disconnect the probe socket — the iframe handles the real connection
      xpraSocket.disconnect();
    });

    xpraSocket.on('error', (e: { message: string }) => {
      setStatus('error');
      setErrorMsg(e.message);
      xpraSocket.disconnect();
    });

    xpraSocket.on('xpra_closed', () => {
      setStatus('error');
      setErrorMsg('Xpra session closed.');
      xpraSocket.disconnect();
    });

    return () => {
      ctrl.disconnect();
      xpraSocket.disconnect();
    };
  }, [token, nodeId]);

  function handleClose() {
    if (confirm('Close this GUI window? All child windows will also be closed.')) {
      controlSocketRef.current?.emit('close_node', { nodeId });
      setTimeout(() => window.close(), 800);
    }
  }

  function sendToXpra(data: string) {
    // Virtual keyboard input is forwarded to the iframe via postMessage
    const iframe = xpraContainerRef.current?.querySelector('iframe');
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'xpra_key_input', data }, '*');
    }
  }

  /**
   * Build the Xpra HTML5 client URL.
   * The Xpra HTML5 server is proxied through the backend at /ws/xpra/.
   * We pass the JWT token as a query parameter so the backend can authenticate
   * the iframe's WebSocket connection.
   */
  const xpraClientUrl = nodeId && token
    ? `/xpra-html5/?nodeId=${encodeURIComponent(nodeId)}&token=${encodeURIComponent(token)}`
    : null;

  return (
    <div style={styles.page}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>{nodeName}</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <ThemeToggle compact />
          <button className="danger" onClick={handleClose}>Close</button>
        </div>
      </div>

      {/* Admin notification modal */}
      {adminMsg && (
        <AdminNotification
          message={adminMsg}
          onAcknowledge={() => { setAdminMsg(null); logout(); navigate('/login'); }}
        />
      )}

      {/* Top panel: Xpra HTML5 client */}
      <div style={styles.xpraPanel} ref={xpraContainerRef}>
        {status === 'connecting' && (
          <div style={styles.overlay}>Connecting to Xpra session…</div>
        )}
        {status === 'error' && (
          <div style={{ ...styles.overlay, color: 'var(--color-danger)' }}>
            {errorMsg}
          </div>
        )}
        {status === 'ready' && xpraClientUrl && (
          <iframe
            src={xpraClientUrl}
            style={{ width: '100%', height: '100%', border: 'none' }}
            title="Xpra GUI"
            allow="clipboard-read; clipboard-write"
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

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TreeNodeLike {
  nodeId: string;
  name: string;
  children?: TreeNodeLike[];
}

function _findNodeName(tree: unknown[], targetId: string): string | null {
  for (const item of tree) {
    const node = item as TreeNodeLike;
    if (node.nodeId === targetId) return node.name;
    if (node.children) {
      const found = _findNodeName(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: 'var(--color-bg)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.5rem 1rem',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  toolbarTitle: { fontWeight: 600, fontSize: '0.9rem' },
  xpraPanel: {
    flex: '0 0 auto',
    minHeight: '60vh',
    position: 'relative',
    background: '#1a1a1a',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#888',
    fontSize: '1rem',
  },
  bottomPanel: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: '0.75rem',
    padding: '0.75rem',
    background: 'var(--color-surface)',
    borderTop: '1px solid var(--color-border)',
  },
};
