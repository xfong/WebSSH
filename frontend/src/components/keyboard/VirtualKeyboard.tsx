import React, { useEffect, useRef, useState } from 'react';
import Keyboard from 'simple-keyboard';
import 'simple-keyboard/build/css/index.css';

interface VirtualKeyboardProps {
  onInput: (data: string) => void;
}

// Map simple-keyboard key names to terminal escape sequences
const KEY_MAP: Record<string, string> = {
  '{enter}': '\r',
  '{bksp}': '\x7f',
  '{tab}': '\t',
  '{esc}': '\x1b',
  '{arrowup}': '\x1b[A',
  '{arrowdown}': '\x1b[B',
  '{arrowright}': '\x1b[C',
  '{arrowleft}': '\x1b[D',
  '{delete}': '\x1b[3~',
  '{home}': '\x1b[H',
  '{end}': '\x1b[F',
  '{pageup}': '\x1b[5~',
  '{pagedown}': '\x1b[6~',
  '{space}': ' ',
};

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'];

export default function VirtualKeyboard({ onInput }: VirtualKeyboardProps) {
  const keyboardRef = useRef<Keyboard | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [heldModifiers, setHeldModifiers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!containerRef.current) return;

    keyboardRef.current = new Keyboard(containerRef.current, {
      onKeyPress: (button: string) => {
        const lower = button.toLowerCase().replace(/[{}]/g, '');

        // Handle modifier keys (sticky)
        if (MODIFIERS.includes(lower)) {
          setHeldModifiers(prev => {
            const next = new Set(prev);
            next.has(lower) ? next.delete(lower) : next.add(lower);
            return next;
          });
          return;
        }

        // Build the key sequence considering held modifiers
        let seq = KEY_MAP[button.toLowerCase()] ?? button;

        setHeldModifiers(prev => {
          if (prev.size === 0) {
            onInput(seq);
            return prev;
          }

          const mods = [...prev];

          // Ctrl combinations
          if (mods.includes('ctrl') && seq.length === 1) {
            const code = seq.toUpperCase().charCodeAt(0) - 64;
            if (code >= 1 && code <= 26) seq = String.fromCharCode(code);
          }

          // Ctrl+Alt+Del special case
          if (mods.includes('ctrl') && mods.includes('alt') && button === '{delete}') {
            seq = '\x1b[3;5~';
          }

          // Alt prefix
          if (mods.includes('alt') && !mods.includes('ctrl')) {
            seq = '\x1b' + seq;
          }

          onInput(seq);
          return new Set(); // release all modifiers after key press
        });
      },
      layout: {
        default: [
          '` 1 2 3 4 5 6 7 8 9 0 - = {bksp}',
          '{tab} q w e r t y u i o p [ ] \\',
          '{lock} a s d f g h j k l ; \' {enter}',
          '{shift} z x c v b n m , . / {shift}',
          'ctrl alt {space} alt ctrl',
        ],
        shift: [
          '~ ! @ # $ % ^ & * ( ) _ + {bksp}',
          '{tab} Q W E R T Y U I O P { } |',
          '{lock} A S D F G H J K L : " {enter}',
          '{shift} Z X C V B N M < > ? {shift}',
          'ctrl alt {space} alt ctrl',
        ],
      },
      display: {
        '{bksp}': '⌫',
        '{enter}': '↵',
        '{tab}': '⇥',
        '{lock}': 'Caps',
        '{shift}': '⇧',
        '{space}': ' ',
        'ctrl': 'Ctrl',
        'alt': 'Alt',
        'meta': '⊞',
        '{esc}': 'Esc',
        '{arrowup}': '↑',
        '{arrowdown}': '↓',
        '{arrowleft}': '←',
        '{arrowright}': '→',
        '{delete}': 'Del',
        '{home}': 'Home',
        '{end}': 'End',
        '{pageup}': 'PgUp',
        '{pagedown}': 'PgDn',
      },
      theme: 'hg-theme-default hg-layout-default webssh-keyboard',
      buttonTheme: heldModifiers.size > 0
        ? [...heldModifiers].map(m => ({
            class: 'hg-activeButton',
            buttons: m,
          }))
        : [],
    });

    return () => { keyboardRef.current?.destroy(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update active modifier highlighting
  useEffect(() => {
    if (!keyboardRef.current) return;
    keyboardRef.current.setOptions({
      buttonTheme: heldModifiers.size > 0
        ? [...heldModifiers].map(m => ({ class: 'hg-activeButton', buttons: m }))
        : [],
    });
  }, [heldModifiers]);

  return (
    <div style={{ flex: 1 }}>
      {heldModifiers.size > 0 && (
        <div style={styles.modIndicator}>
          Active: {[...heldModifiers].join(' + ')}
        </div>
      )}
      <div ref={containerRef} className="simple-keyboard" />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  modIndicator: {
    background: 'var(--color-primary)', color: '#fff',
    padding: '0.2rem 0.6rem', borderRadius: '4px',
    fontSize: '0.8rem', marginBottom: '0.3rem', display: 'inline-block',
  },
};
