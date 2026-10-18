import { createAuthClient } from "better-auth/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

const auth = createAuthClient({ plugins: [oauthProviderClient()] });
const status = document.querySelector<HTMLElement>("#status")!;
const button = document.querySelector<HTMLButtonElement>("#action")!;
button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Continuing…";
  try {
    if (document.body.dataset.page === "sign-in") {
      const email = document.querySelector<HTMLInputElement>("#email")?.value.trim() ?? "";
      const password = document.querySelector<HTMLInputElement>("#password")?.value ?? "";
      const result = await auth.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message);
    } else {
      const result = await auth.oauth2.consent({ accept: true });
      if (result.error) throw new Error(result.error.message);
      if (result.data?.url) window.location.assign(result.data.url);
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Authorization failed";
    button.disabled = false;
  }
});
