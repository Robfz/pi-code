import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellIcon, BellOffIcon, LoaderIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage, getHealth } from "@/lib/api";
import {
  disablePush,
  enablePush,
  type PushState,
  type PushStatus,
  readPushStatus,
} from "@/lib/push";
import { queryKeys } from "@/lib/query-client";
import { PlaceholderScreen } from "@/routes/placeholder";
import { DENSITIES, DENSITY_LABEL, useUiPrefs } from "@/store/ui-prefs";

const PUSH_KEY = ["push-status"] as const;

const STATE_LABEL: Record<PushState, string> = {
  unsupported: "Unsupported",
  denied: "Blocked",
  enabled: "Enabled",
  disabled: "Off",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function pushHint(status: PushStatus): string {
  switch (status.state) {
    case "unsupported":
      return (
        status.reason ??
        "This browser can't receive push notifications. On iPhone, add pi-code to the Home Screen first."
      );
    case "denied":
      return "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.";
    case "enabled":
      return "This device is notified when a run finishes, fails or needs input.";
    case "disabled":
      return "Get notified when a run finishes, fails or needs input.";
  }
}

function NotificationsSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: PUSH_KEY, queryFn: readPushStatus, staleTime: 0 });
  const setState = (state: PushState) => queryClient.setQueryData<PushStatus>(PUSH_KEY, { state });
  const enable = useMutation({
    mutationFn: enablePush,
    onSuccess: (state) => {
      setState(state);
      if (state === "enabled") toast.success("Notifications enabled");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: (state) => {
      setState(state);
      toast.success("Notifications disabled");
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: PUSH_KEY });
    },
  });
  const busy = enable.isPending || disable.isPending;

  return (
    <Section title="Notifications">
      {status.isPending && (
        <p className="flex items-center gap-2">
          <LoaderIcon className="size-4 animate-spin" /> Checking…
        </p>
      )}
      {status.isError && (
        <p role="alert" className="text-destructive">
          {errorMessage(status.error)}
        </p>
      )}
      {status.data && (
        <>
          <div className="flex items-center gap-2">
            <span>Status</span>
            <Badge
              data-testid="push-state"
              variant={status.data.state === "enabled" ? "default" : "outline"}
            >
              {STATE_LABEL[status.data.state]}
            </Badge>
          </div>
          <p>{pushHint(status.data)}</p>
          {status.data.state === "disabled" && (
            <Button
              className="self-start"
              disabled={busy}
              // Straight from the click: the permission prompt needs the user gesture.
              onClick={() => enable.mutate()}
            >
              {enable.isPending ? <LoaderIcon className="animate-spin" /> : <BellIcon />}
              Enable notifications
            </Button>
          )}
          {status.data.state === "enabled" && (
            <Button
              variant="outline"
              className="self-start"
              disabled={busy}
              onClick={() => disable.mutate()}
            >
              {disable.isPending ? <LoaderIcon className="animate-spin" /> : <BellOffIcon />}
              Disable notifications
            </Button>
          )}
        </>
      )}
    </Section>
  );
}

function DensitySection() {
  const density = useUiPrefs((s) => s.density);
  const setDensity = useUiPrefs((s) => s.setDensity);
  return (
    <Section title="Transcript density">
      <p>How much of each turn conversations show (the header menu changes it too).</p>
      <div className="flex flex-wrap gap-2">
        {DENSITIES.map((level) => (
          <Button
            key={level}
            size="sm"
            variant={density === level ? "default" : "outline"}
            aria-pressed={density === level}
            onClick={() => setDensity(level)}
          >
            {DENSITY_LABEL[level].name}
          </Button>
        ))}
      </div>
    </Section>
  );
}

function ThemeSection() {
  const { theme, setTheme } = useTheme();
  return (
    <Section title="Theme">
      <div className="flex flex-wrap gap-2">
        {(["system", "dark", "light"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={theme === option ? "default" : "outline"}
            aria-pressed={theme === option}
            onClick={() => setTheme(option)}
          >
            {option[0]?.toUpperCase()}
            {option.slice(1)}
          </Button>
        ))}
      </div>
    </Section>
  );
}

function AboutSection() {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: getHealth, retry: false });
  return (
    <Section title="About">
      <p>
        pi-code — the pi coding agent on your phone.
        {health.data?.piVersion && (
          <>
            {" "}
            Server runs pi <span className="font-mono">{health.data.piVersion}</span>.
          </>
        )}
      </p>
    </Section>
  );
}

export function SettingsScreen() {
  return (
    <PlaceholderScreen title="Settings">
      <div className="flex flex-col gap-6 pb-8">
        <NotificationsSection />
        <DensitySection />
        <ThemeSection />
        <AboutSection />
      </div>
    </PlaceholderScreen>
  );
}
