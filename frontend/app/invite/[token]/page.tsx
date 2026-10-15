import { InviteScreen } from "@/features/invite/invite-screen";

// /invite/:token. Anyone with the link can read who invited them; joining needs a signed-in account with the invited email (checked by the API).
// The token is read from the address and handed to the screen, which sends it only to the invitation routes (features/invite/invite-api.ts).
export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  return <InviteScreen token={token} />;
}
