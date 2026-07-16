import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import TreeView from '../components/tree/TreeView';
import ThemeToggle from '../components/common/ThemeToggle';
import AdminNotification from '../components/common/AdminNotification';

export interface TreeNode {
  nodeId: string;
  name: string;
  type: 'terminal' | 'xpra';
  parentId: string | null;
  username: string;
  children: TreeNode[];
}

export interface UserTree {
  username: string;
  tree: TreeNode[];
}

export default function SessionTreePage() {
  const { token, username, role, logout } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [trees, setTrees] = useState<UserTree[]>([]);
  const [hostname, setHostname] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [newTermPassword, setNewTermPassword] = useState('');
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);

  useEffect(() => {
    fetch('/api/v1/config').then(r => r.json()).then(d => setHostname(d.hostname || ''));
  }, []);

  useEffect(() => {
    if (!token) return;
    const deviceId = sessionStorage.getItem('deviceId') || crypto.randomUUID();
    sessionStorage.setItem('deviceId', deviceId);

    const socket = io('/ws/control', {
      transports: ['websocket'],
      auth: { token, deviceId },
    });
    socketRef.current = socket;

    socket.on('tree_update', (data: UserTree) => {
      setTrees(prev => {
        const idx = prev.findIndex(t => t.username === data.username);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = data;
          return next;
        }
        return [...prev, data];
      });
    });

    socket.on('admin_tree_update', (data: { tree: Record<string, TreeNode[]> }) => {
      const updated: UserTree[] = Object.entries(data.tree).map(([u, t]) => ({ username: u, tree: t }));
      setTrees(updated);
    });

    socket.on('admin_notification', (data: { message: string }) => {
      setAdminMsg(data.message);
    });

    socket.on('force_close_tabs', () => {
      logout();
      window.close();
    });

    return () => { socket.disconnect(); };
  }, [token, logout]);

  const handleNewTerminal = useCallback(() => {
    setShowPasswordPrompt(true);
  }, []);

  const handlePasswordSubmit = useCallback(() => {
    socketRef.current?.emit('new_terminal', { password: newTermPassword });
    setNewTermPassword('');
    setShowPasswordPrompt(false);

    socketRef.current?.once('terminal_created', (data: { nodeId: string }) => {
      window.open(`/terminal/${data.nodeId}`, '_blank');
    });
  }, [newTermPassword]);

  const handleOpenNode = useCallback((nodeId: string, type: 'terminal' | 'xpra') => {
    const path = type === 'terminal' ? `/terminal/${nodeId}` : `/xpra/${nodeId}`;
    window.open(path, '_blank');
  }, []);

  const handleCloseNode = useCallback((nodeId: string) => {
    socketRef.current?.emit('close_node', { nodeId });
  }, []);

  const handleRenameNode = useCallback((nodeId: string, newName: string) => {
    socketRef.current?.emit('rename_node', { nodeId, newName });
  }, []);

  const handleAdminTerminate = useCallback((userId: string, nodeId?: string, force = false) => {
    socketRef.current?.emit('admin_terminate', { userId, nodeId, force });
  }, []);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.hostname}>{hostname || 'WebSSH'}</span>
        <div style={styles.headerRight}>
          <ThemeToggle />
          <button className="ghost" onClick={logout} style={{ marginLeft: '0.5rem' }}>Sign Out</button>
        </div>
      </header>

      {adminMsg && (
        <AdminNotification message={adminMsg} onAcknowledge={() => { setAdminMsg(null); logout(); }} />
      )}

      {showPasswordPrompt && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h3>Enter your password to start a new terminal</h3>
            <input
              type="password"
              value={newTermPassword}
              onChange={e => setNewTermPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handlePasswordSubmit()}
              autoFocus
              placeholder="Password"
              style={{ margin: '1rem 0' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={() => setShowPasswordPrompt(false)}>Cancel</button>
              <button onClick={handlePasswordSubmit}>Connect</button>
            </div>
          </div>
        </div>
      )}

      <main style={styles.main}>
        <TreeView
          trees={trees}
          hostname={hostname}
          currentUsername={username!}
          role={role!}
          onOpen={handleOpenNode}
          onClose={handleCloseNode}
          onRename={handleRenameNode}
          onNewTerminal={handleNewTerminal}
          onAdminTerminate={handleAdminTerminate}
        />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)' },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.75rem 1.25rem',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    position: 'sticky', top: 0, zIndex: 10,
  },
  hostname: { fontWeight: 700, fontSize: '1.05rem' },
  headerRight: { display: 'flex', alignItems: 'center' },
  main: { flex: 1, padding: '1rem 1.25rem', maxWidth: '900px', width: '100%', margin: '0 auto' },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  },
  modal: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '10px', padding: '1.5rem', width: '100%', maxWidth: '360px',
  },
};
