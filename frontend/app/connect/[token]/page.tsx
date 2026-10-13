import { ConnectScreen } from "@/features/connect/connect-screen";

// /connect/:token. Public: whoever holds the link can use it once. The token is read from the address and handed to the screen, which sends it
// only to the connect-link routes (features/connect/connect-link.ts).
export default async function ConnectPage({ params }: PageProps<"/connect/[token]">) {
  const { token } = await params;
  return <ConnectScreen token={token} />;
}
