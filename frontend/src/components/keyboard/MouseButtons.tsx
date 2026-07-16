import React, { RefObject } from 'react';

interface MouseButtonsProps {
  termRef: RefObject<HTMLDivElement>;
}

/**
 * Five mouse action buttons targeting the terminal panel above.
 * Dispatches synthetic mouse events into the xterm.js container.
 */
export default function MouseButtons({ termRef }: MouseButtonsProps) {
  function dispatchMouseEvent(type: string, button: number) {
    if (!termRef.current) return;
    const el = termRef.current.querySelector('.xterm-helper-textarea') as HTMLElement | null;
    const target = el ?? termRef.current;
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const evt = new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy,
      button, buttons: button === 0 ? 1 : button === 1 ? 4 : 2,
    });
    target.dispatchEvent(evt);
  }

  function dispatchScroll(deltaY: number) {
    if (!termRef.current) return;
    const el = termRef.current.querySelector('.xterm-viewport') as HTMLElement | null;
    const target = el ?? termRef.current;
    const evt = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
    target.dispatchEvent(evt);
  }

  function click(button: number) {
    dispatchMouseEvent('mousedown', button);
    dispatchMouseEvent('mouseup', button);
    dispatchMouseEvent('click', button);
  }

  return (
    <div style={styles.container}>
      {/* Top row: Left, Middle, Right */}
      <div style={styles.row}>
        <button style={styles.btn} onPointerDown={() => click(0)} title="Left Click">L</button>
        <button style={styles.btn} onPointerDown={() => click(1)} title="Middle Click">M</button>
        <button style={styles.btn} onPointerDown={() => click(2)} title="Right Click">R</button>
      </div>
      {/* Bottom column: Scroll Up, Scroll Down */}
      <div style={styles.col}>
        <button style={styles.btn} onPointerDown={() => dispatchScroll(-120)} title="Scroll Up">▲</button>
        <button style={styles.btn} onPointerDown={() => dispatchScroll(120)} title="Scroll Down">▼</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', flexDirection: 'column', gap: '0.4rem',
    border: '1px solid var(--color-border)', borderRadius: '8px',
    padding: '0.5rem', background: 'var(--color-surface)',
    alignSelf: 'flex-start',
  },
  row: { display: 'flex', gap: '0.3rem' },
  col: { display: 'flex', flexDirection: 'column', gap: '0.3rem' },
  btn: {
    minWidth: '44px', minHeight: '44px',
    background: 'var(--color-bg)', color: 'var(--color-text)',
    border: '1px solid var(--color-border)', borderRadius: '6px',
    fontSize: '0.85rem', fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
};
