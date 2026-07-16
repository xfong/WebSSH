import React, { useState, useRef } from 'react';
import { TreeNode, UserTree } from '../../pages/SessionTreePage';

interface TreeViewProps {
  trees: UserTree[];
  hostname: string;
  currentUsername: string;
  role: 'user' | 'admin';
  onOpen: (nodeId: string, type: 'terminal' | 'xpra') => void;
  onClose: (nodeId: string) => void;
  onRename: (nodeId: string, newName: string) => void;
  onNewTerminal: () => void;
  onAdminTerminate: (userId: string, nodeId?: string, force?: boolean) => void;
}

interface ActionMenu {
  nodeId: string;
  username: string;
  type: 'terminal' | 'xpra';
  x: number;
  y: number;
}

export default function TreeView({
  trees, hostname, currentUsername, role,
  onOpen, onClose, onRename, onNewTerminal, onAdminTerminate,
}: TreeViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionMenu, setActionMenu] = useState<ActionMenu | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function startRename(nodeId: string, currentName: string) {
    setRenaming(nodeId);
    setRenameValue(currentName);
    setActionMenu(null);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }

  function commitRename(nodeId: string) {
    if (renameValue.trim()) onRename(nodeId, renameValue.trim());
    setRenaming(null);
  }

  function openMenu(e: React.MouseEvent | React.TouchEvent, node: TreeNode, username: string) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setActionMenu({ nodeId: node.nodeId, username, type: node.type, x: rect.right, y: rect.bottom });
  }

  function renderNode(node: TreeNode, username: string, depth: number): React.ReactNode {
    const isExpanded = expanded.has(node.nodeId);
    const hasChildren = node.children.length > 0;
    const isRenaming = renaming === node.nodeId;

    return (
      <div key={node.nodeId} style={{ paddingLeft: depth * 20 }}>
        <div style={styles.nodeRow}>
          {/* Chevron */}
          <button
            style={{ ...styles.chevron, visibility: hasChildren ? 'visible' : 'hidden' }}
            onClick={() => toggle(node.nodeId)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? '▼' : '▶'}
          </button>

          {/* Icon */}
          <span style={styles.icon}>{node.type === 'terminal' ? '⬛' : '🖼'}</span>

          {/* Label / inline rename */}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={() => commitRename(node.nodeId)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename(node.nodeId);
                if (e.key === 'Escape') setRenaming(null);
              }}
              style={styles.renameInput}
            />
          ) : (
            <span
              style={styles.nodeLabel}
              onClick={() => onOpen(node.nodeId, node.type)}
              title="Click to open"
            >
              {node.name}
            </span>
          )}

          {/* Action menu trigger */}
          <button
            style={styles.menuBtn}
            onClick={(e) => openMenu(e, node, username)}
            onContextMenu={(e) => openMenu(e, node, username)}
            aria-label="Actions"
          >
            ⋮
          </button>
        </div>

        {/* Children */}
        {isExpanded && node.children.map(child => renderNode(child, username, depth + 1))}
      </div>
    );
  }

  return (
    <div style={styles.tree} onClick={() => setActionMenu(null)}>
      {/* Server hostname root */}
      <div style={styles.rootRow}>
        <button style={styles.chevron} onClick={() => toggle('__root__')}>
          {expanded.has('__root__') ? '▼' : '▶'}
        </button>
        <span style={styles.icon}>🖥</span>
        <span style={{ fontWeight: 600 }}>{hostname || 'server'}</span>
      </div>

      {expanded.has('__root__') && trees.map(({ username, tree }) => (
        <div key={username} style={{ paddingLeft: 20 }}>
          {/* Username node */}
          <div style={styles.nodeRow}>
            <button style={styles.chevron} onClick={() => toggle(`user:${username}`)}>
              {expanded.has(`user:${username}`) ? '▼' : '▶'}
            </button>
            <span style={styles.icon}>👤</span>
            <span style={{ fontWeight: 500 }}>{username}</span>

            {/* + button next to username (only for the current user or admin) */}
            {(role === 'admin' || username === currentUsername) && role !== 'admin' && (
              <button
                style={styles.addBtn}
                onClick={onNewTerminal}
                title="New terminal"
              >
                +
              </button>
            )}
            {role !== 'admin' && username === currentUsername && (
              <button style={styles.addBtn} onClick={onNewTerminal} title="New terminal">+</button>
            )}
            {role === 'admin' && (
              <button
                style={{ ...styles.menuBtn, color: 'var(--color-danger)' }}
                onClick={() => onAdminTerminate(username)}
                title="Terminate all sessions"
              >
                ✕
              </button>
            )}
          </div>

          {/* Session nodes */}
          {expanded.has(`user:${username}`) && tree.map(node => renderNode(node, username, 2))}
        </div>
      ))}

      {/* Action menu (bottom sheet on mobile, popover on desktop) */}
      {actionMenu && (
        <div style={{ ...styles.popover, top: actionMenu.y, left: Math.min(actionMenu.x, window.innerWidth - 200) }}>
          <button style={styles.popoverItem} onClick={() => { onOpen(actionMenu.nodeId, actionMenu.type); setActionMenu(null); }}>
            {role === 'admin' ? 'Observe / Interact' : 'Open'}
          </button>
          <button style={styles.popoverItem} onClick={() => { startRename(actionMenu.nodeId, ''); }}>
            Rename
          </button>
          {role === 'admin' ? (
            <>
              <button style={{ ...styles.popoverItem, color: 'var(--color-danger)' }}
                onClick={() => { onAdminTerminate(actionMenu.username, actionMenu.nodeId, false); setActionMenu(null); }}>
                Graceful Terminate
              </button>
              <button style={{ ...styles.popoverItem, color: 'var(--color-danger)' }}
                onClick={() => { onAdminTerminate(actionMenu.username, actionMenu.nodeId, true); setActionMenu(null); }}>
                Force Kill
              </button>
            </>
          ) : (
            <button style={{ ...styles.popoverItem, color: 'var(--color-danger)' }}
              onClick={() => { onClose(actionMenu.nodeId); setActionMenu(null); }}>
              Close
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tree: { position: 'relative', userSelect: 'none' },
  rootRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.2rem', cursor: 'default' },
  nodeRow: {
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    padding: '0.35rem 0.2rem', borderRadius: '5px', cursor: 'default',
    transition: 'background 0.1s',
  },
  chevron: {
    background: 'transparent', color: 'var(--color-text-muted)',
    border: 'none', padding: '0.25rem', minWidth: '28px', minHeight: '28px',
    fontSize: '0.7rem', borderRadius: '4px',
  },
  icon: { fontSize: '0.95rem', lineHeight: 1 },
  nodeLabel: {
    flex: 1, cursor: 'pointer', padding: '0.1rem 0.2rem',
    borderRadius: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  renameInput: {
    flex: 1, padding: '0.15rem 0.3rem', fontSize: '0.95rem',
    border: '1px solid var(--color-primary)', borderRadius: '4px',
    background: 'var(--color-bg)', color: 'var(--color-text)',
  },
  menuBtn: {
    background: 'transparent', color: 'var(--color-text-muted)',
    border: 'none', padding: '0.25rem 0.4rem', minWidth: '28px', minHeight: '28px',
    fontSize: '1.1rem', borderRadius: '4px',
  },
  addBtn: {
    background: 'var(--color-primary)', color: '#fff',
    border: 'none', padding: '0.1rem 0.5rem', borderRadius: '4px',
    fontSize: '1rem', minWidth: '28px', minHeight: '28px',
  },
  popover: {
    position: 'fixed', background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: '8px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)', zIndex: 200,
    minWidth: '180px', overflow: 'hidden',
  },
  popoverItem: {
    display: 'block', width: '100%', textAlign: 'left',
    background: 'transparent', color: 'var(--color-text)',
    border: 'none', borderRadius: 0, padding: '0.6rem 1rem',
    fontSize: '0.9rem',
  },
};
