import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    // Machine-local trust: the setup key held on the owner's device signs in
    // as the single local owner without any interactive credentials.
    ConvexCredentials<DataModel>({
      id: "local-key",
      authorize: async (credentials, ctx) => {
        const key = credentials.key;
        const expected = process.env.ANORVIS_OWNER_SETUP_KEY;
        if (!expected || typeof key !== "string" || !constantTimeEqual(key, expected)) {
          throw new Error("Invalid local owner key");
        }
        const userId = await ctx.runMutation(
          internal.platform.workspace.ensureLocalOwnerUser,
          {},
        );
        return { userId };
      },
    }),
    Password({
      profile: (params) => {
        const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
        if (params.flow === "signUp") {
          const expectedKey = process.env.ANORVIS_OWNER_SETUP_KEY;
          if (!expectedKey || params.setupKey !== expectedKey) {
            throw new Error("Invalid local owner setup key");
          }
          const ownerEmail = process.env.ANORVIS_OWNER_EMAIL?.trim().toLowerCase();
          if (ownerEmail && email !== ownerEmail) {
            throw new Error("This deployment is reserved for its configured owner");
          }
        }
        const defaultName = email.split("@")[0] || "Owner";
        return {
          email,
          name: typeof params.name === "string" ? params.name.trim() : defaultName,
        };
      },
    }),
  ],
});
