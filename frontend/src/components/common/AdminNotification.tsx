import React from 'react';

interface AdminNotificationProps {
  message: string;
  onAcknowledge: () => void;
}

export default function AdminNotification({ message, onAcknowledge }: AdminNotificationProps) {
  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <h2 style={styles.title}>Session Terminated</h2>
        <p style={styles.message}>{message}</p>
        <button onClick={onAcknowledge} style={{ width: '100%', marginTop: '1rem' }}>
          Acknowledge &amp; Return to Login
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: 'var(--color-surface)', border: '2px solid var(--color-danger)',
    borderRadius: '10px', padding: '2rem', maxWidth: '400px', width: '90%',
    textAlign: 'center',
  },
  title: { color: 'var(--color-danger)', marginBottom: '0.75rem' },
  message: { color: 'var(--color-text)', lineHeight: 1.6 },
};
