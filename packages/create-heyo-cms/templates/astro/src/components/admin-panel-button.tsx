import { Button } from "@heyo-sh/heyo-ui/components/button";

// A link needs no hydration: Astro renders the heyo-ui button on the server.
export default function AdminPanelButton() {
  return (
    <Button
      render={<a href="/api/heyo-cms/admin" />}
      variant="primary"
      size="lg"
    >
      Admin Panel
    </Button>
  );
}
