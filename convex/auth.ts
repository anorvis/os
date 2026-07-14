import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
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
