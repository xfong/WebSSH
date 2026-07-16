import React from 'react';
import { useAuth, Theme } from '../../context/AuthContext';

interface ThemeToggleProps {
  compact?: boolean;
}

export default function ThemeToggle({ compact }: ThemeToggleProps) {
  const { theme, setTheme } = useAuth();

  const options: { value: Theme; label: string }[] = [
    { value: 'light', label: compact ? '☀' : '☀ Light' },
    { value: 'dark', label: compact ? '🌙' : '🌙 Dark' },
    { value: 'system', label: compact ? '⚙' : '⚙ System' },
  ];

  return (
    <div style={styles.container}>
      {options.map(({ value, label }) => (
        <button
          key={value}
          className={theme === value ? '' : 'ghost'}
          style={{ padding: '0.3rem 0.6rem', fontSize: compact ? '1rem' : '0.85rem' }}
          onClick={() => setTheme(value)}
          title={value.charAt(0).toUpperCase() + value.slice(1)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', gap: '0.25rem', alignItems: 'center' },
};
