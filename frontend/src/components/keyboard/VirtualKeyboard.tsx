import React, { useEffect, useRef, useState } from 'react';
import Keyboard from 'simple-keyboard';
import 'simple-keyboard/build/css/index.css';

interface VirtualKeyboardProps {
  onInput: (data: string) => void;
}

// ── Terminal escape sequences ─────────────────────────────────────────────────

const KEY_MAP: Record<string, string> = {
  // Navigation
  '{enter}':    '\r',
  '{bksp}':     '\x7f',
  '{tab}':      '\t',
  '{esc}':      '\x1b',
  '{space}':    ' ',
  '{arrowup}':  '\x1b[A',
  '{arrowdown}':'\x1b[B',
  '{arrowright}':'\x1b[C',
  '{arrowleft}': '\x1b[D',
  '{delete}':   '\x1b[3~',
  '{home}':     '\x1b[H',
  '{end}':      '\x1b[F',
  '{pageup}':   '\x1b[5~',
  '{pagedown}': '\x1b[6~',
  '{insert}':   '\x1b[2~',
  // Function keys
  '{f1}':  '\x1bOP',
  '{f2}':  '\x1bOQ',
  '{f3}':  '\x1bOR',
  '{f4}':  '\x1bOS',
  '{f5}':  '\x1b[15~',
  '{f6}':  '\x1b[17~',
  '{f7}':  '\x1b[18~',
  '{f8}':  '\x1b[19~',
  '{f9}':  '\x1b[20~',
  '{f10}': '\x1b[21~',
  '{f11}': '\x1b[23~',
  '{f12}': '\x1b[24~',
};

// Modifier keys that toggle sticky state
const MODIFIER_KEYS = new Set(['ctrl', 'alt', '{shift}', '{lock}', 'meta', 'numlock', 'scrolllock']);

// Keys that are display-only and send nothing
const NOOP_KEYS = new Set(['{numlock}', '{scrolllock}']);

// ── Component ─────────────────────────────────────────────────────────────────

export default function VirtualKeyboard({ onInput }: VirtualKeyboardProps) {
  const keyboardRef = useRef<Keyboard | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [heldModifiers, setHeldModifiers] = useState<Set<string>>(new Set());
  const [capsLock, setCapsLock] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const heldRef = useRef<Set<string>>(new Set());
  const capsRef = useRef(false);
  const shiftRef = useRef(false);

  // Keep refs in sync with state so the keyboard callback (closed over on mount)
  // always sees the latest values without needing to re-register.
  useEffect(() => { heldRef.current = heldModifiers; }, [heldModifiers]);
  useEffect(() => { capsRef.current = capsLock; }, [capsLock]);
  useEffect(() => { shiftRef.current = shiftActive; }, [shiftActive]);

  useEffect(() => {
    if (!containerRef.current) return;

    keyboardRef.current = new Keyboard(containerRef.current, {
      onKeyPress: (button: string) => {
        const lower = button.toLowerCase();

        // ── Caps Lock toggle ──────────────────────────────────────────────────
        if (lower === '{lock}') {
          setCapsLock(prev => !prev);
          capsRef.current = !capsRef.current;
          keyboardRef.current?.setOptions({ layoutName: _layoutName() });
          return;
        }

        // ── Shift toggle ──────────────────────────────────────────────────────
        if (lower === '{shift}') {
          setShiftActive(prev => {
            const next = !prev;
            shiftRef.current = next;
            keyboardRef.current?.setOptions({ layoutName: _layoutName() });
            return next;
          });
          return;
        }

        // ── Other sticky modifiers (Ctrl, Alt, Meta, NumLock, ScrollLock) ────
        if (MODIFIER_KEYS.has(lower)) {
          setHeldModifiers(prev => {
            const next = new Set(prev);
            next.has(lower) ? next.delete(lower) : next.add(lower);
            heldRef.current = next;
            return next;
          });
          return;
        }

        // ── Display-only keys ─────────────────────────────────────────────────
        if (NOOP_KEYS.has(lower)) return;

        // ── Build the output sequence ─────────────────────────────────────────
        const mods = heldRef.current;
        let seq = KEY_MAP[lower] ?? button;

        // Apply Caps Lock / Shift to single alphabetic characters
        if (seq.length === 1 && /[a-z]/i.test(seq)) {
          const upper = capsRef.current !== shiftRef.current; // XOR
          seq = upper ? seq.toUpperCase() : seq.toLowerCase();
        }

        // Ctrl combinations: Ctrl+A = \x01 … Ctrl+Z = \x1a
        if (mods.has('ctrl') && seq.length === 1) {
          const code = seq.toUpperCase().charCodeAt(0) - 64;
          if (code >= 1 && code <= 26) seq = String.fromCharCode(code);
        }

        // Ctrl+Alt+Del special case
        if (mods.has('ctrl') && mods.has('alt') && lower === '{delete}') {
          seq = '\x1b[3;5~';
        }

        // Alt prefix (ESC + key)
        if (mods.has('alt') && !mods.has('ctrl')) {
          seq = '\x1b' + seq;
        }

        onInput(seq);

        // Release Shift after one key press (sticky-once behaviour)
        if (shiftRef.current) {
          setShiftActive(false);
          shiftRef.current = false;
          keyboardRef.current?.setOptions({ layoutName: _layoutName() });
        }

        // Release all non-lock modifiers after key press
        if (mods.size > 0) {
          const next = new Set<string>();
          setHeldModifiers(next);
          heldRef.current = next;
        }
      },

      // ── Layouts ─────────────────────────────────────────────────────────────
      layout: {
        default: [
          '{esc} {f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12}',
          '` 1 2 3 4 5 6 7 8 9 0 - = {bksp}',
          '{tab} q w e r t y u i o p [ ] \\',
          '{lock} a s d f g h j k l ; \' {enter}',
          '{shift} z x c v b n m , . / {shift}',
          'ctrl alt {space} alt ctrl {insert} {delete} {home} {end} {pageup} {pagedown}',
          '{arrowup}',
          '{arrowleft} {arrowdown} {arrowright}',
        ],
        shift: [
          '{esc} {f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12}',
          '~ ! @ # $ % ^ & * ( ) _ + {bksp}',
          '{tab} Q W E R T Y U I O P { } |',
          '{lock} A S D F G H J K L : " {enter}',
          '{shift} Z X C V B N M < > ? {shift}',
          'ctrl alt {space} alt ctrl {insert} {delete} {home} {end} {pageup} {pagedown}',
          '{arrowup}',
          '{arrowleft} {arrowdown} {arrowright}',
        ],
      },

      layoutName: 'default',

      // ── Display labels ───────────────────────────────────────────────────────
      display: {
        '{bksp}':      '⌫',
        '{enter}':     '↵',
        '{tab}':       '⇥',
        '{lock}':      'Caps',
        '{shift}':     '⇧',
        '{space}':     '␣',
        '{esc}':       'Esc',
        '{insert}':    'Ins',
        '{delete}':    'Del',
        '{home}':      'Home',
        '{end}':       'End',
        '{pageup}':    'PgUp',
        '{pagedown}':  'PgDn',
        '{arrowup}':   '↑',
        '{arrowdown}': '↓',
        '{arrowleft}': '←',
        '{arrowright}':'→',
        '{f1}':  'F1',  '{f2}':  'F2',  '{f3}':  'F3',  '{f4}':  'F4',
        '{f5}':  'F5',  '{f6}':  'F6',  '{f7}':  'F7',  '{f8}':  'F8',
        '{f9}':  'F9',  '{f10}': 'F10', '{f11}': 'F11', '{f12}': 'F12',
        'ctrl':       'Ctrl',
        'alt':        'Alt',
        'meta':       '⊞',
        'numlock':    'NumLk',
        'scrolllock': 'ScrLk',
      },

      theme: 'hg-theme-default hg-layout-default webssh-keyboard',
    });

    return () => { keyboardRef.current?.destroy(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Highlight active modifier keys
  useEffect(() => {
    if (!keyboardRef.current) return;
    const activeButtons = [
      ...[...heldModifiers],
      ...(capsLock ? ['{lock}'] : []),
      ...(shiftActive ? ['{shift}'] : []),
    ];
    keyboardRef.current.setOptions({
      buttonTheme: activeButtons.length > 0
        ? [{ class: 'hg-activeButton', buttons: activeButtons.join(' ') }]
        : [],
    });
  }, [heldModifiers, capsLock, shiftActive]);

  function _layoutName(): string {
    return shiftRef.current ? 'shift' : 'default';
  }

  const activeLabels = [
    ...[...heldModifiers].map(m => m.replace(/[{}]/g, '').toUpperCase()),
    ...(capsLock ? ['CAPS'] : []),
    ...(shiftActive ? ['SHIFT'] : []),
  ];

  return (
    <div style={{ flex: 1 }}>
      {activeLabels.length > 0 && (
        <div style={styles.modIndicator}>
          Active: {activeLabels.join(' + ')}
        </div>
      )}
      <div ref={containerRef} className="simple-keyboard" />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  modIndicator: {
    background: 'var(--color-primary)',
    color: '#fff',
    padding: '0.2rem 0.6rem',
    borderRadius: '4px',
    fontSize: '0.8rem',
    marginBottom: '0.3rem',
    display: 'inline-block',
  },
};
