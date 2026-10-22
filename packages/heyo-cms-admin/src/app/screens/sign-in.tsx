import type { PanelConfig, SignInResult } from "@heyo-sh/heyo-cms/types";
import { Button, Card, Heading, Input, Separator, Text } from "@heyo-sh/heyo-ui"; // prettier-ignore
import { IconKey, IconMail, IconUserPlus } from "@tabler/icons-react";
import { useState } from "react";

import { ApiError, api, mount } from "../lib/api";
import { LayoutFigure } from "../art/layout-figure";
import { ErrorNote } from "../components/chrome";

/**
 * The only screen an anonymous caller sees.
 *
 * It is drawn from `GET /panel`, which is public for exactly this reason: the
 * methods offered here are the methods the handler actually registered, so
 * the panel never shows a magic-link button on a deployment where that route
 * does not exist (it exists only when `admin.auth.deliverToken` does).
 *
 * The session is a cookie the server sets. Nothing is stored by this screen,
 * which is why signing in ends with a reload rather than with state: a fresh
 * load re-reads the session and the configuration as the new person.
 */
export function SignIn({ config }: { config: PanelConfig }) {
  // A deployment with no accounts has nobody to sign in as, so the same
  // screen asks for the first one instead. The server decides this, not the
  // panel: the flag comes from `GET /panel` and the route it enables closes
  // itself the moment the account exists.
  if (config.auth.setupRequired) return <ClaimFirstAccount config={config} />;
  return <SignInForm config={config} />;
}

function Frame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="heyo-auth-layout">
      <main className="heyo-auth-form" aria-labelledby="heyo-auth-title">
        <Card variant="raised" className="w-full max-w-sm p-6">
          <Heading id="heyo-auth-title" level={1} className="text-lg">
            {title}
          </Heading>
          <Text size="sm" tone="subtle" className="mt-0.5 mb-5">
            {description}
          </Text>
          {children}
        </Card>
      </main>
      {/* The second column is a drawing, not a photograph: it is part of the
          bundle, costs no request, and answers the pointer while somebody
          reads the form. It is hidden under 768px, where the form is the
          whole screen. */}
      <aside className="heyo-auth-art">
        <LayoutFigure className="heyo-auth-figure" />
      </aside>
    </div>
  );
}

function SignInForm({ config }: { config: PanelConfig }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const methods = config.auth.methods;
  const oauth = ["github", "google", "microsoft"].filter((provider) =>
    methods.includes(provider),
  );
  if (config.auth.sso) oauth.push("oidc");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = challenge
        ? await api.post<SignInResult>("/auth/2fa/verify", {
            body: { challenge, code },
          })
        : await api.post<SignInResult>("/auth/sign-in", {
            body: { email, password },
          });

      if (result.status === "two-factor-required") {
        setChallenge(result.challenge);
        return;
      }
      window.location.href = mount.panelPath;
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const requestLink = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/magic-link", { body: { email } });
      // The response says nothing about whether the address exists, and
      // neither does this: the same sentence either way.
      setSent(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      title={config.title}
      description={
        challenge
          ? "Enter the code from your authenticator app."
          : "Sign in to edit."
      }
    >
      {methods.includes("password") || challenge ? (
        <form onSubmit={submit} className="space-y-3">
          {challenge ? (
            <Input
              label="Six-digit code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          ) : (
            <>
              <Input
                label="Email"
                type="email"
                autoFocus
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Input
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </>
          )}

          <Button
            type="submit"
            variant="primary"
            shape="block"
            icon={IconKey}
            loading={busy}
          >
            {challenge ? "Verify" : "Sign in"}
          </Button>
        </form>
      ) : null}

      <ErrorNote error={error} className="mt-3" />

      {config.auth.magicLink && !challenge ? (
        <div className="mt-3">
          {sent ? (
            <Text size="sm" tone="subtle">
              If that address has an account, a sign-in link is on its way.
            </Text>
          ) : (
            <Button
              variant="outline"
              shape="block"
              icon={IconMail}
              disabled={busy || email === ""}
              onClick={() => void requestLink()}
            >
              Email me a link
            </Button>
          )}
        </div>
      ) : null}

      {oauth.length > 0 && !challenge ? (
        <div className="mt-4 space-y-2">
          <Separator label="or" />
          {oauth.map((provider) => (
            <Button
              key={provider}
              variant="outline"
              shape="block"
              className="capitalize"
              nativeButton={false}
              /* A real link: OAuth starts with a redirect, and a fetch would
                 lose the provider's own session cookies. */
              render={
                <a
                  href={api.url(`/auth/oauth/${provider}`, {
                    redirectTo: mount.panelPath,
                  })}
                />
              }
            >
              Continue with {provider === "oidc" ? "SSO" : provider}
            </Button>
          ))}
        </div>
      ) : null}

      {config.auth.passwordReset && !challenge ? (
        <Button
          variant="link"
          size="xs"
          className="mt-4 px-0"
          onClick={async () => {
            setBusy(true);
            try {
              await api.post("/auth/password/forgot", { body: { email } });
              setSent(true);
            } catch (cause) {
              setError(cause);
            } finally {
              setBusy(false);
            }
          }}
        >
          Forgot your password?
        </Button>
      ) : null}
    </Frame>
  );
}

/**
 * The screen a brand-new deployment opens on.
 *
 * There is exactly one state in which this is drawn — `cms_users` is empty —
 * and submitting it ends that state for good, which is why it is not a
 * registration form in any ordinary sense: the second person to load this
 * page gets the sign-in screen, and the second person to submit it gets a
 * 409. Everything after this is invitations, which require a session.
 *
 * The confirmation field is the only client-side rule here. Password length
 * is the server's to enforce, and it says so in its own words rather than
 * having the panel guess at a configured minimum.
 *
 * That rule is checked **on submit, not on every keystroke**. A form that
 * turns red while you are still typing the second password is telling you
 * you got it wrong before you have finished getting it right; the mismatch
 * only becomes a fact once you have said you are done. After that it is
 * live again — by then the message is about the edit you are making to fix
 * it, which is the one time it helps.
 */
function ClaimFirstAccount({ config }: { config: PanelConfig }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const mismatch = submitted && confirm !== password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<SignInResult>("/auth/setup", {
        body: {
          email,
          password,
          ...(name.trim() === "" ? {} : { name: name.trim() }),
        },
      });
      window.location.href = mount.panelPath;
    } catch (cause) {
      // Somebody claimed it between this page loading and this click. The
      // honest next screen is the sign-in form, which a reload produces,
      // because `GET /panel` now answers `setupRequired: false`.
      if (cause instanceof ApiError && cause.status === 409) {
        window.location.reload();
        return;
      }
      setError(cause);
      setBusy(false);
    }
  };

  return (
    <Frame
      title={config.title}
      description="Nobody has claimed this CMS yet. The account you create here is the administrator, and this form closes behind it."
    >
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Email"
          type="email"
          autoFocus
          required
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Input
          label="Name"
          optional
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Input
          label="Repeat password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          {...(mismatch
            ? { error: "The two passwords are not the same." }
            : {})}
          onChange={(event) => setConfirm(event.target.value)}
        />

        {/* Not disabled on a mismatch: pressing it is how the mismatch gets
            reported in the first place. */}
        <Button
          type="submit"
          variant="primary"
          shape="block"
          icon={IconUserPlus}
          loading={busy}
          disabled={busy || password === "" || email === ""}
        >
          Create the administrator
        </Button>
      </form>

      <ErrorNote error={error} className="mt-3" />
    </Frame>
  );
}
