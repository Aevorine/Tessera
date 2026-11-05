import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AppWindow,
  Keyboard,
  MousePointerClick,
  TextCursorInput,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { TooltipProvider } from "@/components/ui/tooltip";
import { translateError } from "@/i18n/errors";
import { vaultApi } from "@/lib/vaultApi";
import type { AiDesktopConfirmEvent } from "@/shared/ipcTypes";

type Decision = "allow" | "allow_all" | "deny";

const TOOL_META: Record<string, { icon: LucideIcon; key: string }> = {
  desktop_launch_app: { icon: AppWindow, key: "launch" },
  desktop_click: { icon: MousePointerClick, key: "click" },
  desktop_type_text: { icon: Keyboard, key: "type" },
  desktop_set_value: { icon: TextCursorInput, key: "setValue" },
  desktop_press_key: { icon: Keyboard, key: "key" },
};

/** AI 桌面动作的执行前确认：后端等这里的回答，Esc / 关闭 / 超时都按拒绝。 */
export function DesktopActionConfirm() {
  const { t } = useTranslation("ai");
  const [queue, setQueue] = useState<
    Array<AiDesktopConfirmEvent & { at: number }>
  >([]);
  const [now, setNow] = useState(() => Date.now());
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const current = queue[0];

  useEffect(
    () =>
      vaultApi.onEvent((payload) => {
        if (payload.event === "ai_desktop_confirm") {
          setQueue((q) => [...q, { ...payload, at: Date.now() }]);
        } else if (payload.event === "ai_desktop_confirm_closed") {
          if (!queueRef.current.some((x) => x.id === payload.id)) return;
          toast.message(t("desktopConfirmTimedOut"));
          setQueue((q) => q.filter((x) => x.id !== payload.id));
        }
      }),
    [t],
  );

  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [current]);

  // 后端重启时「已关闭」事件会丢：到点自己撤下，后端那边本来也按超时拒绝
  useEffect(() => {
    if (!current) return;
    const due = current.at + Math.max(1, current.timeout_s) * 1000 - now;
    if (due > 0) return;
    setQueue((q) => q.filter((x) => x.id !== current.id));
    toast.message(t("desktopConfirmTimedOut"));
  }, [current, now, t]);

  const answer = useCallback(
    (decision: Decision) => {
      if (!current) return;
      const id = current.id;
      setQueue((q) => q.filter((x) => x.id !== id));
      void vaultApi
        .call("ai_desktop_confirm_respond", { id, decision })
        .then((res) => {
          if (!res.ok) toast.error(translateError(res.error ?? ""));
        })
        .catch((e: unknown) =>
          toast.error(translateError(e instanceof Error ? e.message : "")),
        );
    },
    [current],
  );

  if (!current) return null;
  const meta = TOOL_META[current.tool] ?? {
    icon: MousePointerClick,
    key: "click",
  };
  const Icon = meta.icon;
  const s = current.summary ?? {};
  const total = Math.max(1, current.timeout_s) * 1000;
  const left = Math.max(0, total - (now - current.at));
  const rows: Array<[string, string]> = [];
  if (s.app) rows.push([t("desktopConfirmApp"), s.app]);
  if (s.process) rows.push([t("desktopConfirmTarget"), s.process]);
  if (s.key) rows.push([t("desktopConfirmKey"), s.key]);
  if (current.tool === "desktop_click")
    rows.push([
      t("desktopConfirmButton"),
      `${s.button ?? "left"}${s.count && s.count > 1 ? ` ×${s.count}` : ""}`,
    ]);

  // 挂在 App 根上、在 AppShell 的 TooltipProvider 之外：DialogContent 的关闭按钮带 Tooltip，必须自带 Provider
  return (
    <TooltipProvider delayDuration={200}>
      <Dialog open onOpenChange={(open) => !open && answer("deny")}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="size-5 text-primary" />
              {t(`desktopConfirmTitle.${meta.key}`)}
            </DialogTitle>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 truncate font-medium" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {s.text && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-sm">
              {s.text}
            </pre>
          )}
          <Progress
            value={(left / total) * 100}
            className="h-1"
            aria-label={t("desktopConfirmCountdown", {
              seconds: Math.ceil(left / 1000),
            })}
          />
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => answer("deny")}>
              {t("desktopConfirmDeny")}
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => answer("allow_all")}>
                {t("desktopConfirmAllowAll")}
              </Button>
              <Button onClick={() => answer("allow")}>
                {t("desktopConfirmAllow")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
