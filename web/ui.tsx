import {
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
  useEffect,
} from "react";
import {
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";
import { errorText } from "./api";
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const lock = useRef(false),
    mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await fn();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
      return undefined;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, error, notice, run, setError, setNotice };
}
export function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && (
        <div className="notice error" role="alert">
          <AlertCircle size={17} />
          <span>{action.error}</span>
        </div>
      )}
      {action.notice && (
        <div className="notice success" role="status">
          <CheckCircle2 size={17} />
          <span>{action.notice}</span>
        </div>
      )}
    </>
  );
}
export function Button({
  children,
  busy = false,
  kind = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  kind?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`button ${kind} ${className}`}
    >
      {busy && <Loader2 size={16} className="spin" />}
      {children}
    </button>
  );
}
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon || <ArrowRight size={24} />}</div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

