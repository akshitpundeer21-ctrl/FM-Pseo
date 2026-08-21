import { cookies } from "next/headers";
import { logout, SESSION_COOKIE } from "@/core/security/auth";
import { fail, ok } from "@/app/api/_lib/handler";

export async function POST() {
  try {
    const store = await cookies();
    await logout(store.get(SESSION_COOKIE)?.value);
    store.delete(SESSION_COOKIE);
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
