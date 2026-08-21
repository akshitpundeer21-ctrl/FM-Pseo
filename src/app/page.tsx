import { redirect } from "next/navigation";
import { currentAuth } from "@/core/security/auth";

export const dynamic = "force-dynamic";

export default async function Root() {
  const auth = await currentAuth();
  redirect(auth ? "/dashboard" : "/login");
}
