import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, CircleCheck, Inbox, X } from 'lucide-react';

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge badge-${value.replaceAll('_', '-')}`}>{label || value.replaceAll('_', ' ')}</span>;
}
export function Empty({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <div className="empty"><Inbox size={26} strokeWidth={1.5} /><strong>{title}</strong>{detail ? <p>{detail}</p> : null}{children}</div>;
}
export function Panel({ title, eyebrow, action, children, className = '' }: { title: string; eyebrow?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-heading"><div>{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}<h2>{title}</h2></div>{action}</div>{children}</section>;
}
export function SectionHeading({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return <div className="section-heading"><div><h1>{title}</h1><p>{detail}</p></div>{children ? <div className="button-row">{children}</div> : null}</div>;
}
export function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="text-button" onClick={onClick}>{children}<ArrowUpRight size={15}/></button>;
}
export function Modal({ title, detail, onClose, children }: { title: string; detail?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="dialog-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading"><div><h2 id="dialog-title">{title}</h2>{detail ? <p>{detail}</p> : null}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>;
}
export function Success({ children }: { children: ReactNode }) { return <div className="success" role="status"><CircleCheck size={17}/>{children}</div>; }
export function ErrorNotice({ message }: { message: string }) { return <div className="error-notice" role="alert">{message}</div>; }
export function formatTime(time: string) {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(date);
}
export function money(cents: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100); }
export function number(value: number) { return new Intl.NumberFormat('en-US').format(value); }
