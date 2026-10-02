import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { canCloseQueryTabs, type QueryTabCloseScope } from '../lib/queryTabClose';

const actions: { scope: QueryTabCloseScope; label: string }[] = [
  { scope: 'current', label: '현재 탭 닫기' },
  { scope: 'others', label: '다른 탭 닫기' },
  { scope: 'left', label: '왼쪽 탭 닫기' },
  { scope: 'right', label: '오른쪽 탭 닫기' },
  { scope: 'all', label: '모든 탭 닫기' },
];

interface Props {
  tabs: readonly { id: string; loading: boolean }[];
  targetId: string;
  x: number;
  y: number;
  onClose: () => void;
  onSelect: (scope: QueryTabCloseScope) => void;
}

export function QueryTabContextMenu({ tabs, targetId, x, y, onClose, onSelect }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });

    const dismissOutside = (event: Event) => {
      if (!menu.contains(event.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('wheel', dismissOutside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('wheel', dismissOutside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [x, y, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu query-tab-menu"
      role="menu"
      aria-label="쿼리 탭 닫기"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus({ preventScroll: true });
        }
      }}
    >
      {actions.map(({ scope, label }) => (
        <button
          key={scope}
          role="menuitem"
          className="ctx-item"
          disabled={!canCloseQueryTabs(tabs, targetId, scope)}
          title={!canCloseQueryTabs(tabs, targetId, scope) ? '닫을 탭이 없거나 쿼리가 실행 중입니다.' : undefined}
          onClick={() => onSelect(scope)}
        >
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
