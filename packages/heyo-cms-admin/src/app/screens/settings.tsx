import type {
  ActivityPage,
  AiProviderStatus,
  ApiKeyRecord,
  CmsUser,
  IssuedApiKey,
  InviteResult,
  RoleRecord,
  WebhookDelivery,
  WebhookSubscription,
} from "@heyo-sh/heyo-cms/types";
import {
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  DataTable,
  Dialog,
  Empty,
  Field,
  Input,
  Select,
  Tabs,
  Text,
} from "@heyo-sh/heyo-ui";
import {
  IconActivity,
  IconKey,
  IconLanguage,
  IconPlus,
  IconTrash,
  IconUserPlus,
  IconWebhook,
} from "@tabler/icons-react";
import { type ComponentProps, type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDateTime, formatRelative } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { useRouter } from "../lib/router";
import { toast } from "../lib/toast";
import { usePageTab } from "../components/ai-assistant";
import { ErrorNote } from "../components/chrome";
import { useConfirm } from "../components/confirm";
import { Page, PageBar, PageBody, PageLoader, PageStrip } from "../components/page"; // prettier-ignore

/**
 * Everything that is not content.
 *
 * Editors, roles, languages, API keys, AI and webhooks — each one a thin
 * front end for endpoints the API already answers. Deployment gathers the
 * other code-owned settings in one read-only place rather than adding a tab
 * per switch. The AI tab manages provider keys when the deployment allows it
 * (`ai.storage.secret`), and the webhook tab is the one place "it did not
 * arrive" can be answered: status,
 * the receiver's own response, and a replay button.
 *
 * Two things are owned here rather than by the tabs. **The primary action**
 * — invite, issue a key, subscribe a receiver — lives in the
 * navigation row beside the trail, because a button that creates the thing a
 * screen lists is a property of the screen, not a row inside its content;
 * each tab is handed the open state and draws its own dialog. The sentence
 * that qualifies each tab lives in its data table's description, where it is
 * visible with the records it explains.
 */
export function Settings() {
  const { query, navigate } = useRouter();
  const { config, can } = usePanel();
  const tab = query.get("tab") ?? "users";
  const [creating, setCreating] = useState(false);

  // The tab is in the query string, which the panel's router keeps out of
  // `path` — so without this the assistant hears "the settings screen" on
  // all eight of them and cannot tell webhooks from API keys.
  usePageTab(tab);

  const tabs = [
    { value: "users", label: "Editors" },
    { value: "roles", label: "Roles" },
    { value: "locales", label: "Languages" },
    ...(config.auth.apiKeys ? [{ value: "keys", label: "API keys" }] : []),
    ...(config.ai.configured ? [{ value: "ai", label: "AI" }] : []),
    ...(config.webhooks.enabled
      ? [{ value: "webhooks", label: "Webhooks" }]
      : []),
    { value: "deployment", label: "Deployment" },
    { value: "activity", label: "Activity" },
  ];

  // Languages have no button: `i18n.locales` is code, and a panel that
  // offered to add one would be offering to edit a file it cannot see.
  const action =
    tab === "users" && can("users:invite")
      ? { label: "Invite editor", icon: IconUserPlus }
      : tab === "keys"
        ? { label: "New API key", icon: IconPlus }
        : tab === "webhooks" && can("webhooks:create")
          ? { label: "Subscribe receiver", icon: IconPlus }
          : null;

  return (
    <Page>
      {/* The trail says "Settings" and stops there on every tab: the strip
          below it is already the answer to "which one", and a crumb
          repeating the selected segment two centimetres above it is the
          same fact twice. */}
      <PageBar
        crumbs={[{ label: "Settings" }]}
        locale={false}
        usage={
          tab === "users"
            ? { kind: "users" }
            : tab === "locales"
              ? { kind: "locales" }
              : tab === "keys" && config.auth.apiKeys
                ? { kind: "keys" }
                : undefined
        }
        actions={
          action ? (
            <Button
              size="sm"
              variant="primary"
              icon={action.icon}
              onClick={() => setCreating(true)}
            >
              {action.label}
            </Button>
          ) : null
        }
      />

      <Tabs
        variant="segmented"
        value={tab}
        onValueChange={(value) => {
          // The bar's button belongs to the tab under it, so its dialog
          // cannot outlive the move to another one.
          setCreating(false);
          navigate(`/settings?tab=${String(value)}`);
        }}
        className="min-h-0 flex-1 gap-0"
      >
        {/* A second bar rather than a row of tabs floating in the content:
            same height and the same hairline as the trail above it, so the
            two read as one piece of chrome. */}
        <PageStrip>
          <Tabs.List items={tabs} />
        </PageStrip>

        <Tabs.Panel value={tab} className="flex min-h-0 flex-1 flex-col">
          <PageBody>
            {tab === "users" ? (
              <Users creating={creating} onCreating={setCreating} />
            ) : null}
            {tab === "roles" ? <Roles /> : null}
            {tab === "locales" ? <Locales /> : null}
            {tab === "keys" ? (
              <ApiKeys creating={creating} onCreating={setCreating} />
            ) : null}
            {tab === "ai" ? <Ai /> : null}
            {tab === "webhooks" ? (
              <Webhooks creating={creating} onCreating={setCreating} />
            ) : null}
            {tab === "deployment" ? <Deployment /> : null}
            {tab === "activity" ? <Activity /> : null}
          </PageBody>
        </Tabs.Panel>
      </Tabs>
    </Page>
  );
}

/** What every tab is handed: the bar's button, and a way to close it. */
interface CreatingProps {
  creating: boolean;
  onCreating: (open: boolean) => void;
}

/**
 * A select with a label over it, laid out exactly as `Input` lays its own
 * out — `Field`'s 6px gap and `Label`'s type, rather than a `Text` with
 * `as="label"` and a `space-y` that guessed at both.
 *
 * heyo-ui 0.3.1 takes `label` on `Select` itself
 * ([heyo-ui#10](https://github.com/heyo-sh/heyo-ui/pull/10)) and this becomes
 * one prop.
 */
function SettingsEmpty(props: ComponentProps<typeof Empty>) {
  return (
    <div className="py-6">
      <Empty {...props} />
    </div>
  );
}

function LabelledSelect({
  label,
  value,
  onValueChange,
  options,
  description,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  description?: string;
}) {
  const items = options.map((option) => ({ value: option, label: option }));

  // Base UI wires the label to the trigger through the field context, so
  // there is no `htmlFor` to pass and clicking the label still opens it.
  return (
    <Field label={label} {...(description ? { description } : {})}>
      <Select
        value={value}
        items={items}
        onValueChange={(next) => onValueChange(String(next))}
      >
        <Select.Trigger aria-label={label} />
        <Select.Content items={items} />
      </Select>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function Users({ creating, onCreating }: CreatingProps) {
  const { config, can } = usePanel();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(config.rbac.roles[0] ?? "");
  const [invite, setInvite] = useState<InviteResult | null>(null);

  const users = useAsync(
    (signal) =>
      api.get<{ users: CmsUser[]; totalUsers: number }>("/users", {
        signal,
        query: { limit: 100 },
      }),
    [],
  );

  const send = async () => {
    try {
      const result = await api.post<InviteResult>("/users/invite", {
        body: { email, ...(role ? { roles: [role] } : {}) },
      });
      // The token comes back here and nowhere else: an administrator who may
      // create accounts is being handed a link to send, since the CMS does
      // not send email.
      setInvite(result);
      onCreating(false);
      setEmail("");
      await users.reload();
    } catch (error) {
      toast.error(error);
    }
  };

  if (users.loading && !users.data) return <PageLoader />;

  return (
    <div className="space-y-3">
      <ErrorNote error={users.error} />

      <DataTable
        title="Editors"
        description="An invitation is a single-use link this panel shows once: the CMS never sends email."
        rows={users.data?.users ?? []}
        getRowId={(user) => user.id}
        columnToggle={false}
        columns={[
          {
            id: "editor",
            header: "Editor",
            primary: true,
            cell: (user) => (
              <>
                <Text size="xs">{user.name ?? user.email}</Text>
                <Text size="xs" tone="subtle">
                  {user.email}
                </Text>
              </>
            ),
          },
          {
            id: "status",
            header: "Status",
            cell: (user) => (
              <Badge size="sm" variant="neutral">
                {user.status}
              </Badge>
            ),
          },
          {
            id: "roles",
            header: "Roles",
            cell: (user) => (
              <div className="flex flex-wrap gap-1">
                {user.roles.map((entry) => (
                  <Badge key={entry} size="sm" variant="outline">
                    {entry}
                  </Badge>
                ))}
              </div>
            ),
          },
          {
            id: "role",
            header: "Role",
            align: "end",
            cell: (user) =>
              can("users:update") && config.rbac.roles.length > 0 ? (
                <div className="flex justify-end">
                  <Select
                    value={user.roles[0] ?? ""}
                    onValueChange={async (next) => {
                      try {
                        await api.patch(`/users/${user.id}`, {
                          body: { roles: [String(next)] },
                        });
                        toast.success("Role updated.");
                        await users.reload();
                      } catch (error) {
                        toast.error(error);
                      }
                    }}
                  >
                    <Select.Trigger
                      size="sm"
                      className="w-36"
                      aria-label={`Role for ${user.email}`}
                    />
                    <Select.Content
                      items={config.rbac.roles.map((name) => ({
                        value: name,
                        label: name,
                      }))}
                    />
                  </Select>
                </div>
              ) : null,
          },
        ]}
        empty={
          <SettingsEmpty
            icon={IconUserPlus}
            title="No editor accounts yet"
            description="Everyone signing in so far has done it through SSO or an API key. Invite one to give them a password."
            action={
              can("users:invite") ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon={IconUserPlus}
                  onClick={() => onCreating(true)}
                >
                  Invite an editor
                </Button>
              ) : undefined
            }
            hint="Or run heyo-cms create-admin from your terminal."
          />
        }
      />

      <Dialog open={creating} onOpenChange={onCreating}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Invite an editor</Dialog.Title>
            <Dialog.Description>
              Creates the account and returns a single-use link. The CMS never
              sends email.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body className="space-y-3">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {config.rbac.roles.length > 0 ? (
              <LabelledSelect
                label="Role"
                value={role}
                onValueChange={setRole}
                options={config.rbac.roles}
              />
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={() => onCreating(false)}>
              Cancel
            </Button>
            <Button disabled={email === ""} onClick={() => void send()}>
              Create invitation
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      <Dialog
        open={invite !== null}
        onOpenChange={(open) => !open && setInvite(null)}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Send this link</Dialog.Title>
            <Dialog.Description>
              It is shown once, works once, and expires.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Secret value={invite?.token ?? ""} label="Invitation token" />
          </Dialog.Body>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function Roles() {
  const roles = useAsync(
    (signal) => api.get<{ roles: RoleRecord[] }>("/roles", { signal }),
    [],
  );

  if (roles.loading && !roles.data) return <PageLoader />;

  return (
    <div className="space-y-3">
      <ErrorNote error={roles.error} />
      <DataTable
        title="Roles"
        description="View each role and the permissions it gives to editors."
        rows={roles.data?.roles ?? []}
        getRowId={(role) => role.name}
        columnToggle={false}
        columns={[
          {
            id: "role",
            header: "Role",
            primary: true,
            cell: (role) => role.label ?? role.name,
          },
          {
            id: "source",
            header: "Source",
            cell: (role) => (
              <Badge
                size="sm"
                variant="outline"
                title={
                  role.source === "config"
                    ? "Declared in the configuration; the panel must not edit code."
                    : "Created in the panel and stored in cms_roles."
                }
              >
                {role.source}
              </Badge>
            ),
          },
          {
            id: "permissions",
            header: "Permissions",
            cell: (role) => (
              <Text size="xs" tone="subtle" mono>
                {role.permissions.join("  ")}
              </Text>
            ),
          },
        ]}
        empty={
          <SettingsEmpty
            title="No roles"
            description="Roles are defined in the CMS configuration. Add roles there to make them available to editors."
          />
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * The languages, as they are configured.
 *
 * A list rather than a registry: `i18n.locales` is code, so the panel shows
 * what the deployment declared and never offers to add a row the next deploy
 * would contradict. The name beside each code is the one the switcher uses,
 * so what an editor picks from and what an administrator reads here agree.
 */
function Locales() {
  const { config } = usePanel();

  return (
    <div className="space-y-3">
      <DataTable
        title="Languages"
        description="Declared in i18n.locales in the CMS configuration. Every localized field is stored in each of them."
        rows={config.i18n.locales}
        getRowId={(locale) => locale.code}
        columnToggle={false}
        columns={[
          {
            id: "code",
            header: "Code",
            primary: true,
            className: "font-mono",
            cell: (locale) => locale.code,
          },
          {
            id: "language",
            header: "Language",
            cell: (locale) => (
              <span className="flex items-center gap-1.5">
                {locale.name}
                {locale.isDefault ? (
                  <Badge size="sm" variant="contrast">
                    default
                  </Badge>
                ) : null}
                {locale.rtl ? (
                  <Badge size="sm" variant="outline">
                    rtl
                  </Badge>
                ) : null}
              </span>
            ),
          },
        ]}
        empty={
          <SettingsEmpty
            icon={IconLanguage}
            title="No languages"
            description="Languages are defined in i18n.locales in the CMS configuration."
          />
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeys({ creating, onCreating }: CreatingProps) {
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [revokedIds, setRevokedIds] = useState<string[]>([]);

  const keys = useAsync(
    (signal) => api.get<{ keys: ApiKeyRecord[] }>("/auth/api-keys", { signal }),
    [],
  );

  const issue = async () => {
    try {
      const key = await api.post<IssuedApiKey>("/auth/api-keys", {
        body: { name },
      });
      // Closing first, then showing the key: two dialogs open at once is
      // the one way to lose a value that is shown exactly once.
      onCreating(false);
      setIssued(key);
      setName("");
      await keys.reload();
    } catch (error) {
      toast.error(error);
    }
  };

  if (keys.loading && !keys.data) return <PageLoader />;

  return (
    <div className="space-y-3">
      <ErrorNote error={keys.error} />

      <DataTable
        title="API keys"
        description="A key is shown once, never holds more than the account it belongs to, and can never issue another key."
        rows={(keys.data?.keys ?? []).filter(
          (key) => !key.revokedAt && !revokedIds.includes(key.id),
        )}
        getRowId={(key) => key.id}
        columnToggle={false}
        columns={[
          {
            id: "name",
            header: "Name",
            primary: true,
            cell: (key) => key.name,
          },
          {
            id: "key",
            header: "Key",
            cell: (key) => (
              <Text size="xs" tone="subtle" mono>
                {key.prefix}…
              </Text>
            ),
          },
          {
            id: "created",
            header: "Created",
            cell: (key) => (
              <Text size="sm" tone="subtle" as="span">
                {formatRelative(key.createdAt)}
              </Text>
            ),
          },
          {
            id: "last-used",
            header: "Last used",
            cell: (key) => (
              <Text size="sm" tone="subtle" as="span">
                {key.lastUsedAt ? formatRelative(key.lastUsedAt) : "never"}
              </Text>
            ),
          },
          {
            id: "actions",
            header: "Actions",
            actions: true,
            cell: (key) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void confirm({
                    title: `Revoke ${key.name}?`,
                    description:
                      "Every request still using this key starts failing immediately. A revoked key cannot be brought back.",
                    consequences: [`${key.prefix}\u2026`],
                    confirmLabel: "Revoke",
                    destructive: true,
                    run: async () => {
                      await api.delete(`/auth/api-keys/${key.id}`);
                      setRevokedIds((current) => [...current, key.id]);
                      toast.success("Revoked.");
                      await keys.reload();
                    },
                  })
                }
              >
                Revoke
              </Button>
            ),
          },
        ]}
        empty={
          <SettingsEmpty
            icon={IconKey}
            title="No API keys"
            description="A key authenticates a machine against the same access rules an editor gets."
            action={
              <Button
                size="sm"
                variant="primary"
                icon={IconPlus}
                onClick={() => onCreating(true)}
              >
                New API key
              </Button>
            }
            hint="Send it as Authorization: Bearer, the same as a session."
          />
        }
      />

      <Dialog open={creating} onOpenChange={onCreating}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>New API key</Dialog.Title>
            <Dialog.Description>
              Bound to your account and never wider: a key can never issue
              another key, and never holds more than you do.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Input
              label="Name"
              value={name}
              placeholder="deploy script"
              description="Shown in this list and in the audit trail. Name it after the thing that will hold it."
              onChange={(event) => setName(event.target.value)}
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={() => onCreating(false)}>
              Cancel
            </Button>
            <Button disabled={name.trim() === ""} onClick={() => void issue()}>
              Issue key
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      <Dialog
        open={issued !== null}
        onOpenChange={(open) => !open && setIssued(null)}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Copy this key</Dialog.Title>
            <Dialog.Description>
              It is shown once. The server keeps a hash, not the key.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Secret value={issued?.key ?? ""} label="API key" />
          </Dialog.Body>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI and webhooks
// ---------------------------------------------------------------------------

/**
 * AI: the models, and the keys that are allowed to be managed from here.
 *
 * A key is write-only in both directions that matter. It is posted once and
 * never answered with; what comes back is "configured", where it came from,
 * and the last four characters — enough to recognise the key somebody meant,
 * useless to anybody who gets a copy of this response.
 */
function Ai() {
  const { config } = usePanel();
  const [editing, setEditing] = useState<string | null>(null);
  const [token, setToken] = useState("");

  const providers = useAsync(
    (signal) =>
      api.get<{ providers: AiProviderStatus[] }>("/ai/providers", { signal }),
    [],
  );

  const save = async (provider: string) => {
    try {
      await api.put(`/ai/providers/${provider}`, { body: { token } });
      setEditing(null);
      setToken("");
      await providers.reload();
      toast.success(`Stored the ${provider} key.`);
    } catch (error) {
      toast.error(error);
    }
  };

  const forget = async (provider: string) => {
    try {
      await api.delete(`/ai/providers/${provider}`);
      await providers.reload();
      toast.success(`Removed the stored ${provider} key.`);
    } catch (error) {
      toast.error(error);
    }
  };

  if (providers.loading && !providers.data) return <PageLoader />;

  return (
    <div className="space-y-3">
      <Card className="gap-2 p-3">
        <Text size="sm" weight="medium" tone="strong" as="h2">
          AI configuration
        </Text>
        <Text size="xs" tone="subtle">
          Models, assistant limits and field actions are declared in the CMS
          configuration. Change them in code and redeploy; only provider keys
          can be stored here.
        </Text>
        <Row
          label="Default model"
          value={
            config.ai.defaultModel
              ? `${config.ai.defaultModel.provider} · ${config.ai.defaultModel.model}`
              : "—"
          }
        />
        <Row label="Assistant" value={config.ai.assistant ? "on" : "off"} />
        {config.ai.assistantSettings ? (
          <>
            <Row
              label="Assistant model"
              value={`${config.ai.assistantSettings.model.provider} · ${config.ai.assistantSettings.model.model}`}
            />
            <Row
              label="Run limits"
              value={`${config.ai.assistantSettings.maxTurns} turns · ${config.ai.assistantSettings.maxToolCalls} tool calls · ${config.ai.assistantSettings.timeoutMs / 1000}s timeout`}
            />
            <Row
              label="Custom instructions"
              value={
                config.ai.assistantSettings.customInstructions ? "set" : "none"
              }
            />
          </>
        ) : null}
        <Row
          label="Registered actions"
          value={config.ai.actions.join(", ") || "—"}
        />
      </Card>

      <ErrorNote error={providers.error} />

      <DataTable
        title="AI providers"
        description={
          config.ai.managedKeys
            ? "Keys typed here are encrypted with ai.storage.secret before they are stored and are never sent back to a browser. A key stored here wins over one in ai.auth."
            : "Keys come from ai.auth and cannot be edited here. Set ai.storage.secret to manage them from the panel."
        }
        rows={providers.data?.providers ?? []}
        getRowId={(provider) => provider.provider}
        columnToggle={false}
        columns={[
          {
            id: "provider",
            header: "Provider",
            primary: true,
            cell: (provider) => provider.provider,
          },
          {
            id: "key",
            header: "Key",
            cell: (provider) => (
              <span className="flex items-center gap-2">
                <Badge
                  size="sm"
                  variant={provider.configured ? "success" : "neutral"}
                  dot
                >
                  {provider.configured
                    ? provider.source === "database"
                      ? "stored here"
                      : "from the configuration"
                    : "no key"}
                </Badge>
                {provider.hint ? (
                  <Text size="xs" tone="subtle" as="span" mono>
                    {provider.hint}
                  </Text>
                ) : null}
              </span>
            ),
          },
          {
            id: "actions",
            header: "Actions",
            actions: true,
            cell: (provider) =>
              config.ai.managedKeys ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(provider.provider);
                      setToken("");
                    }}
                  >
                    {provider.source === "database" ? "Replace" : "Set key"}
                  </Button>
                  {provider.source === "database" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      shape="square"
                      icon={IconTrash}
                      aria-label={`Forget the ${provider.provider} key`}
                      onClick={() => void forget(provider.provider)}
                    />
                  ) : null}
                </>
              ) : null,
          },
        ]}
        empty={
          <SettingsEmpty
            title="No AI providers"
            description="Configure a provider to make it available to the editor."
          />
        }
      />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Key for {editing ?? ""}</Dialog.Title>
            <Dialog.Description>
              Stored encrypted. You will not be able to read it back.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Input
              label="Provider key"
              type="password"
              value={token}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={token.trim() === ""}
              onClick={() => void save(editing as string)}
            >
              Store
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}

/**
 * Webhooks: subscriptions, what happened to each delivery, and replay.
 *
 * The delivery list is the screen that matters. "It did not arrive" is the
 * only webhook support question there is, and answering it needs the status,
 * the response the receiver gave and a button that sends the same event
 * again — which is what the columns and the replay button are.
 */
function Webhooks({ creating, onCreating }: CreatingProps) {
  const { config } = usePanel();
  const confirm = useConfirm();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["document.*"]);
  const [selected, setSelected] = useState<string | null>(null);

  const webhooks = useAsync(
    (signal) =>
      api.get<{ webhooks: WebhookSubscription[] }>("/webhooks", { signal }),
    [],
  );
  const deliveries = useAsync(
    (signal) =>
      api.get<{ entries: WebhookDelivery[] }>(
        selected ? `/webhooks/${selected}/deliveries` : "/webhooks/deliveries",
        { signal, query: { limit: 25 } },
      ),
    [selected],
  );

  const create = async () => {
    try {
      await api.post("/webhooks", { body: { url, events } });
      onCreating(false);
      setUrl("");
      await webhooks.reload();
      toast.success("Subscribed.");
    } catch (error) {
      toast.error(error);
    }
  };

  const act = async (
    action: () => Promise<unknown>,
    message: string,
  ): Promise<void> => {
    try {
      await action();
      await Promise.all([webhooks.reload(), deliveries.reload()]);
      toast.success(message);
    } catch (error) {
      toast.error(error);
    }
  };

  // One spinner for the tab, not one per request: the subscriptions and
  // their deliveries are two halves of the same screen.
  if (
    (webhooks.loading && !webhooks.data) ||
    (deliveries.loading && !deliveries.data)
  ) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-4">
      <ErrorNote error={webhooks.error} />

      <DataTable
        title="Subscriptions"
        description="Deliveries are signed with HMAC-SHA256. Five attempts with backoff, then one is parked as failed and stays replayable."
        rows={webhooks.data?.webhooks ?? []}
        getRowId={(webhook) => webhook.id}
        columnToggle={false}
        onRowClick={(webhook) =>
          setSelected(selected === webhook.id ? null : webhook.id)
        }
        columns={[
          {
            id: "receiver",
            header: "Receiver",
            primary: true,
            cell: (webhook) => (
              <span className="flex items-center gap-1.5">
                <Text size="sm" as="span" mono truncate>
                  {webhook.url}
                </Text>
                {webhook.active ? null : (
                  <Badge size="sm" variant="neutral">
                    paused
                  </Badge>
                )}
                {webhook.hasSecret ? (
                  <Badge size="sm" variant="outline">
                    own secret
                  </Badge>
                ) : null}
              </span>
            ),
          },
          {
            id: "events",
            header: "Events",
            cell: (webhook) => (
              <Text size="xs" tone="subtle" as="span">
                {webhook.events.join(", ")}
              </Text>
            ),
          },
          {
            id: "actions",
            header: "Actions",
            actions: true,
            cell: (webhook) => (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void act(
                      () => api.post(`/webhooks/${webhook.id}/test`),
                      "Test event sent.",
                    )
                  }
                >
                  Send test
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void act(
                      () =>
                        api.patch(`/webhooks/${webhook.id}`, {
                          body: { active: !webhook.active },
                        }),
                      webhook.active ? "Paused." : "Resumed.",
                    )
                  }
                >
                  {webhook.active ? "Pause" : "Resume"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  shape="square"
                  icon={IconTrash}
                  aria-label="Delete subscription"
                  onClick={() =>
                    void confirm({
                      title: "Delete this subscription?",
                      description:
                        "The receiver stops being told about anything. Deliveries already queued for it are dropped.",
                      consequences: [webhook.url, webhook.events.join(", ")],
                      confirmLabel: "Delete",
                      destructive: true,
                      run: () =>
                        act(
                          () => api.delete(`/webhooks/${webhook.id}`),
                          "Unsubscribed.",
                        ),
                    })
                  }
                />
              </>
            ),
          },
        ]}
        empty={
          <SettingsEmpty
            icon={IconWebhook}
            title="No subscriptions"
            description="Nothing is listening to this CMS yet."
            action={
              <Button
                size="sm"
                variant="primary"
                icon={IconPlus}
                onClick={() => onCreating(true)}
              >
                Subscribe a receiver
              </Button>
            }
            hint="Deliveries are signed; verify the signature before trusting one."
          />
        }
      />

      <div className="space-y-2">
        <ErrorNote error={deliveries.error} />
        <DataTable
          title={
            selected ? "Deliveries for this subscription" : "Recent deliveries"
          }
          description="A delivery appears the moment an event matches one of the subscriptions above."
          rows={deliveries.data?.entries ?? []}
          getRowId={(delivery) => delivery.id}
          columnToggle={false}
          columns={[
            {
              id: "status",
              header: "Status",
              cell: (delivery) => (
                <Badge
                  size="sm"
                  dot
                  variant={
                    delivery.status === "delivered"
                      ? "success"
                      : delivery.status === "pending"
                        ? "warning"
                        : "danger"
                  }
                >
                  {delivery.status}
                </Badge>
              ),
            },
            {
              id: "event",
              header: "Event",
              primary: true,
              className: "font-mono",
              cell: (delivery) => delivery.eventType,
            },
            {
              id: "attempt",
              header: "Attempt",
              cell: (delivery) => (
                <Text size="xs" tone="subtle" as="span">
                  {delivery.attempt}
                  {delivery.responseStatus === null
                    ? ""
                    : ` · ${delivery.responseStatus}`}
                  {delivery.error ? ` · ${delivery.error}` : ""}
                </Text>
              ),
            },
            {
              id: "when",
              header: "When",
              align: "end",
              cell: (delivery) => (
                <Text size="xs" tone="subtle" as="span">
                  {formatRelative(delivery.createdAt)}
                </Text>
              ),
            },
            {
              id: "actions",
              header: "Actions",
              actions: true,
              cell: (delivery) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void act(
                      () =>
                        api.post(`/webhooks/deliveries/${delivery.id}/retry`),
                      "Replayed.",
                    )
                  }
                >
                  Replay
                </Button>
              ),
            },
          ]}
          empty={
            <SettingsEmpty
              icon={IconWebhook}
              title="Nothing delivered yet"
              description="A delivery appears the moment an event matches one of the subscriptions above."
              hint="Send test on a subscription is the fastest way to see one."
            />
          }
        />
      </div>

      <Dialog open={creating} onOpenChange={onCreating}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>New subscription</Dialog.Title>
            <Dialog.Description>
              Deliveries are signed; verify the signature before trusting one.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body className="space-y-3">
            <Input
              label="URL"
              value={url}
              placeholder="https://example.com/hooks/cms"
              onChange={(event) => setUrl(event.target.value)}
            />
            <LabelledSelect
              label="Events"
              value={events[0] ?? "document.*"}
              onValueChange={(value) => setEvents([value])}
              options={config.webhooks.events}
            />
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={() => onCreating(false)}>
              Cancel
            </Button>
            <Button disabled={url.trim() === ""} onClick={() => void create()}>
              Subscribe
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}

/** Read-only deployment facts: configuration is code, not an editable row. */
function Deployment() {
  const { config } = usePanel();
  const { auth, media, trash, rbac, plugins } = config;

  return (
    <div className="space-y-3">
      <DeploymentTable
        title="Access & sign-in"
        description="These settings come from the CMS configuration. Change them in code and redeploy; the panel does not edit the deployment."
        rows={[
          {
            label: "Sign-in methods",
            value: auth.methods.join(", ") || "none",
          },
          {
            label: "Two-factor authentication",
            value: auth.twoFactor ? "on" : "off",
          },
          {
            label: "SSO issuer",
            value: auth.sso ? (
              <Code className="break-all">{auth.sso}</Code>
            ) : (
              "—"
            ),
          },
          { label: "API keys", value: auth.apiKeys ? "on" : "off" },
          {
            label: "Roles",
            value: rbac.enabled
              ? rbac.customRoles
                ? "configured + custom"
                : "configured"
              : "not configured",
          },
        ]}
      />
      <DeploymentTable
        title="Storage & retention"
        rows={[
          { label: "Media uploads", value: media.enabled ? "on" : "off" },
          ...(media.enabled
            ? [
                {
                  label: "Allowed files",
                  value: <CodeList values={media.accept} empty="any" />,
                },
                {
                  label: "Maximum file size",
                  value: media.maxFileSize ?? "no limit",
                },
                {
                  label: "Image variants",
                  value: <CodeList values={media.variants} empty="none" />,
                },
                {
                  label: "Variant generation",
                  value: media.variantMode ? (
                    <Code>{media.variantMode}</Code>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "Unused media purged after",
                  value: media.purgeAfter ?? "never",
                },
              ]
            : []),
          { label: "Trash", value: trash.enabled ? "on" : "off" },
          ...(trash.enabled
            ? [
                {
                  label: "Trash purged after",
                  value: trash.purgeAfter ?? "never",
                },
              ]
            : []),
        ]}
      />
      {plugins.length > 0 ? (
        <DeploymentTable
          title="Plugins"
          rows={[
            {
              label: "Installed",
              value: (
                <CodeList
                  values={plugins.map((plugin) => plugin.id)}
                  empty="none"
                />
              ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

function DeploymentTable({
  title,
  description,
  rows,
}: {
  title: string;
  description?: string;
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <DataTable
      title={title}
      description={description}
      rows={rows}
      getRowId={(row) => row.label}
      columnToggle={false}
      className="[&_table]:table-fixed"
      columns={[
        {
          id: "setting",
          header: "Setting",
          headerClassName: "w-1/2",
          className: "w-1/2",
          primary: true,
          cell: (row) => row.label,
        },
        {
          id: "value",
          header: "Value",
          headerClassName: "w-1/2",
          className: "w-1/2 break-words",
          cell: (row) => row.value,
        },
      ]}
    />
  );
}

function CodeList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return empty;
  return (
    <span className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Code key={value} className="break-all">
          {value}
        </Code>
      ))}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <Text size="sm" tone="subtle" as="span">
        {label}
      </Text>
      <Text size="sm" as="span">
        {value}
      </Text>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function Activity() {
  const activity = useAsync(
    (signal) =>
      api.get<ActivityPage>("/activity", { signal, query: { limit: 50 } }),
    [],
  );

  if (activity.loading && !activity.data) return <PageLoader />;

  return (
    <div className="space-y-3">
      <ErrorNote error={activity.error} />
      <DataTable
        title="Activity"
        description="One line per committed change, written by the engine inside the transaction that caused it."
        rows={activity.data?.entries ?? []}
        getRowId={(entry) => entry.id}
        columnToggle={false}
        columns={[
          {
            id: "action",
            header: "Action",
            primary: true,
            className: "font-mono",
            cell: (entry) => entry.action,
          },
          {
            id: "target",
            header: "Target",
            cell: (entry) => (
              <Text size="sm" tone="subtle" as="span">
                {entry.collection ?? "—"}
                {entry.documentId ? ` · ${entry.documentId}` : ""}
              </Text>
            ),
          },
          {
            id: "actor",
            header: "Actor",
            cell: (entry) => (
              <Text size="sm" tone="subtle" as="span">
                {entry.actorId ?? "system"}
              </Text>
            ),
          },
          {
            id: "when",
            header: "When",
            align: "end",
            cell: (entry) => (
              <Text size="xs" tone="subtle" as="span">
                {formatDateTime(entry.createdAt)}
              </Text>
            ),
          },
        ]}
        empty={
          <SettingsEmpty
            icon={IconActivity}
            title="Nothing recorded yet"
            description="The engine writes one line per committed change, inside the transaction that caused it."
          />
        }
      />
    </div>
  );
}

/**
 * A value that is shown once and has to leave the screen correctly.
 *
 * heyo-ui's `CopyButton` owns the "Copied" state and the timer, which is the
 * part that gets written three times in a codebase and differently each time.
 */
function Secret({ value, label }: { value: string; label: string }) {
  return (
    <Input
      label={label}
      readOnly
      value={value}
      className="font-mono text-xs"
      suffix={<CopyButton value={value} size="sm" />}
    />
  );
}
