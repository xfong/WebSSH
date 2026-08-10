/**
 * XpraPage.tsx
 *
 * Renders a GUI window tab. The Xpra HTML5 client is loaded in an iframe
 * that connects directly to the Xpra HTML5 server via the nginx proxy at
 * /xpra-proxy/PORT/. The backend provides the proxy URL via a REST call.
 *
 * A control socket monitors for admin notifications and force-close signals.
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState<string>('GUI Window');
  const [xpraProxyUrl, setXpraProxyUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !nodeId) return;
    const deviceId = sessionStorage.getItem('deviceId') || crypto.randomUUID();
    sessionStorage.setItem('deviceId', deviceId);

    // ── Fetch the Xpra proxy URL from the backend ─────────────────────────────
    fetch(`/api/v1/xpra-url/${nodeId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ url: string; port: number }>;
      })
      .then(({ url }) => {
        setXpraProxyUrl(url);
        setStatus('ready');
      })
      .catch((err) => {
        setStatus('error');
        setErrorMsg(`Failed to get Xpra URL: ${err.message}`);
      });

    // ── Control socket: admin_notification and force_close_tabs ──────────────
    const ctrl = io('/ws/control', {
      transports: ['websocket', 'polling'],
      auth: { token, deviceId },
    });
    controlSocketRef.current = ctrl;

    ctrl.on('admin_notification', (d: { message: string }) => {
      setAdminMsg(d.message);
    });

    ctrl.on('force_close_tabs', (d: { nodeId?: string; deviceId?: string }) => {
      if (d.nodeId === nodeId || d.deviceId === deviceId) {
        ctrl.disconnect();
        window.close();
      }
    });

    // Fetch node name from tree updates
    ctrl.on('tree_update', (d: { tree: unknown[] }) => {
      const name = _findNodeName(d.tree as TreeNodeLike[], nodeId);
      if (name) setNodeName(name);
    });

    return () => {
      ctrl.disconnect();
    };
  }, [token, nodeId]);

  function handleClose() {
    if (confirm('Close this GUI window? All child windows will also be closed.')) {
      controlSocketRef.current?.emit('close_node', { nodeId });
      setTimeout(() => window.close(), 800);
    }
  }

  function sendToXpra(data: string) {
    // Forward virtual keyboard input to the Xpra iframe via postMessage
    const iframe = xpraContainerRef.current?.querySelector('iframe');
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'xpra_key_input', data }, '*');
    }
  }

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

      {/* Top panel: Xpra HTML5 client via nginx proxy */}
      <div style={styles.xpraPanel} ref={xpraContainerRef}>
        {status === 'loading' && (
          <div style={styles.overlay}>Loading Xpra session…</div>
        )}
        {status === 'error' && (
          <div style={{ ...styles.overlay, color: 'var(--color-danger)' }}>
            {errorMsg}
          </div>
        )}
        {status === 'ready' && xpraProxyUrl && (
          <iframe
            src={xpraProxyUrl}
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

function _findNodeName(tree: TreeNodeLike[], targetId: string): string | null {
  for (const node of tree) {
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
