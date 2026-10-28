import type { ReactNode } from 'react';

export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="description">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'danger' | 'success';
}) {
  return (
    <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">◌</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function PendingButton({ children }: { children: ReactNode }) {
  return (
    <span className="pending-action">
      <button disabled>{children}</button>
      <small>业务接口待接入</small>
    </span>
  );
}
