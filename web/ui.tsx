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







export const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

